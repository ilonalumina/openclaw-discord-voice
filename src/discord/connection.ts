import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  type VoiceConnection,
} from "@discordjs/voice";
import { Client, GatewayIntentBits, type Guild } from "discord.js";
import {
  RECONNECT_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  HEARTBEAT_INTERVAL_MS,
} from "../constants.js";

/**
 * Manages the @discordjs/voice connection for a single guild.
 * Handles joining, leaving, reconnection, and heartbeat monitoring.
 */
export class DiscordConnection {
  readonly guildId: string;
  private client: Client;
  private connection: VoiceConnection | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private channelId: string | null = null;

  constructor(guildId: string, client: Client) {
    this.guildId = guildId;
    this.client = client;
  }

  /** Join a Discord voice channel. Resolves when the connection is ready. */
  async join(channelId: string, isReconnect = false): Promise<VoiceConnection> {
    this.channelId = channelId;
    // Only a FRESH join resets the counter: attemptRejoin() funnels back
    // through here, and resetting on that path made RECONNECT_MAX_ATTEMPTS
    // unreachable — an infinite rejoin loop at a flat 500ms backoff.
    if (!isReconnect) {
      this.reconnectAttempts = 0;
    }

    const guild = await this.resolveGuild();
    // cache.get() returns undefined for any channel the bot hasn't cached yet
    // (common right after connect / for voice channels it has never touched),
    // which surfaced as a false "does not exist". Fall back to a REST fetch.
    const channel =
      guild.channels.cache.get(channelId) ??
      (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isVoiceBased()) {
      throw new Error(`Channel ${channelId} is not a voice channel or does not exist`);
    }

    // The first voice handshake after a cold start regularly exceeds a tight
    // window and then succeeds on a fresh attempt. Use a longer Ready timeout and
    // retry once with a brand-new connection before surfacing the failure — so the
    // caller (the agent's discord_voice tool) doesn't have to be asked to join twice.
    const READY_TIMEOUT_MS = 30_000;
    const JOIN_ATTEMPTS = 2;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= JOIN_ATTEMPTS; attempt++) {
      this.createConnection(channelId, guild);

      try {
        await entersState(this.connection!, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      } catch (err) {
        lastErr = err;
        this.destroyCurrentConnection();
        if (attempt < JOIN_ATTEMPTS) {
          console.warn(
            `[DiscordConnection:${this.guildId}] Voice handshake timed out; retrying join (attempt ${attempt + 1}/${JOIN_ATTEMPTS})`
          );
          await sleep(RECONNECT_DELAY_MS);
        }
        continue;
      }

      if (attempt > 1) {
        // Silent-playback guard: a handshake that only succeeded after a failed
        // attempt has produced connections that report Ready while Discord
        // drops their audio (the voice session appears superseded by the dead
        // first attempt — STT/LLM/TTS all work, playback is silent, zero
        // errors). A manual leave+rejoin reliably fixed it, so do that here:
        // discard the suspect connection and hand back only a connection born
        // from a clean first-shot handshake.
        console.warn(
          `[DiscordConnection:${this.guildId}] Joined on retry — discarding suspect session and rejoining cleanly (silent-playback guard)`
        );
        this.destroyCurrentConnection();
        await sleep(RECONNECT_DELAY_MS);
        this.createConnection(channelId, guild);
        try {
          await entersState(this.connection!, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
        } catch (err) {
          this.destroyCurrentConnection();
          throw new Error(
            `Voice rejoin after retry-join failed (silent-playback guard): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      this.startHeartbeat();
      return this.connection!;
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private createConnection(channelId: string, guild: Guild): void {
    this.connection = joinVoiceChannel({
      channelId,
      guildId: this.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.setupStateHandlers();
  }

  private destroyCurrentConnection(): void {
    // Tear the dead connection down so its handlers can't fire mid-retry.
    try { this.connection?.destroy(); } catch { /* already destroyed */ }
    this.connection = null;
  }

  /** Leave the voice channel and clean up. */
  async leave(): Promise<void> {
    this.stopHeartbeat();

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    this.channelId = null;
    this.reconnectAttempts = 0;
  }

  get voiceConnection(): VoiceConnection | null {
    return this.connection;
  }

  get isConnected(): boolean {
    return (
      this.connection !== null &&
      this.connection.state.status === VoiceConnectionStatus.Ready
    );
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private setupStateHandlers(): void {
    if (!this.connection) return;

    // Capture the instance these handlers belong to: during join retries a
    // destroyed attempt's handlers can fire after a newer connection has
    // replaced it — without this guard they would tear down the live one.
    const conn = this.connection;

    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.connection !== conn) return;

      // Give Discord 5 seconds to self-heal before we attempt a manual rejoin
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, RECONNECT_DELAY_MS),
          entersState(conn, VoiceConnectionStatus.Connecting, RECONNECT_DELAY_MS),
        ]);
        // Discord is reconnecting on its own — wait for Ready
        await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
        this.reconnectAttempts = 0;
      } catch {
        // Self-heal failed — attempt manual rejoin
        if (this.connection === conn) {
          await this.attemptRejoin();
        }
      }
    });

    conn.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.connection !== conn) return;
      this.stopHeartbeat();
      this.connection = null;
    });
  }

  private async attemptRejoin(): Promise<void> {
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS || !this.channelId) {
      console.error(
        `[DiscordConnection:${this.guildId}] Max reconnect attempts reached. Giving up.`
      );
      await this.leave();
      return;
    }

    this.reconnectAttempts++;
    const delay = 500 * Math.pow(2, this.reconnectAttempts - 1);
    await sleep(delay);

    console.warn(
      `[DiscordConnection:${this.guildId}] Attempting rejoin (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`
    );

    try {
      await this.join(this.channelId, true);
      this.reconnectAttempts = 0; // success — fresh budget for the next incident
    } catch {
      await this.attemptRejoin();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) {
        console.warn(`[DiscordConnection:${this.guildId}] Heartbeat detected stale connection`);
        void this.attemptRejoin();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async resolveGuild(): Promise<Guild> {
    const guild = this.client.guilds.cache.get(this.guildId)
      ?? await this.client.guilds.fetch(this.guildId);

    if (!guild) {
      throw new Error(`Guild ${this.guildId} not found`);
    }

    return guild;
  }
}

// ── Discord client factory ────────────────────────────────────────────────────

let sharedClient: Client | null = null;

/** Get (or create) the shared Discord.js client instance. */
export function getDiscordClient(token: string): Client {
  if (!sharedClient) {
    sharedClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
      ],
    });
  }

  if (!sharedClient.isReady()) {
    void sharedClient.login(token);
  }

  return sharedClient;
}

/** Cleanly destroy the shared client. Call on plugin stop. */
export async function destroyDiscordClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.destroy();
    sharedClient = null;
  }
}

/** Helper to get an existing voice connection without creating one */
export function getExistingConnection(guildId: string): VoiceConnection | undefined {
  return getVoiceConnection(guildId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
