import type { ResolvedConfig } from "../types.js";
import { VoiceSession } from "./voice-session.js";
import type { CoreBridge } from "../core-bridge.js";
import { destroyDiscordClient } from "../discord/connection.js";

type Logger = {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
};

/**
 * Manages active VoiceSession instances across multiple guilds.
 *
 * Responsibilities:
 *   - Create and start sessions when the bot joins a voice channel
 *   - Stop and clean up sessions when the bot leaves
 *   - Provide access to existing sessions (for speak/status commands)
 *   - Stop all sessions on plugin shutdown
 */
export class SessionManager {
  private sessions = new Map<string, VoiceSession>();
  private config: ResolvedConfig;
  private coreBridge: CoreBridge;
  private logger: Logger;

  constructor(config: ResolvedConfig, coreBridge: CoreBridge, logger: Logger) {
    this.config = config;
    this.coreBridge = coreBridge;
    this.logger = logger;
  }

  /**
   * Join a guild's voice channel. If a session already exists, leave first.
   * Returns the new session.
   */
  async join(guildId: string, channelId: string): Promise<VoiceSession> {
    // Leave any existing session in this guild
    if (this.sessions.has(guildId)) {
      await this.leave(guildId);
    }

    const context = {
      guildId,
      channelId,
      config: this.config,
    };

    const session = new VoiceSession(context, this.coreBridge);

    session.on("error", (err: Error) => {
      this.logger.error(`[SessionManager] Error in guild ${guildId}:`, err);
    });

    session.on("stopped", () => {
      // Clean up from the map when the session stops itself (e.g. Discord disconnect)
      if (this.sessions.get(guildId) === session) {
        this.sessions.delete(guildId);
      }
    });

    session.on("transcript-in", (userId: string, text: string) => {
      this.logger.info(`[${guildId}] User ${userId}: ${text}`);
    });

    session.on("transcript-out", (text: string) => {
      this.logger.info(`[${guildId}] Bot: ${text}`);
    });

    // Store the session before awaiting start() to prevent concurrent joins
    this.sessions.set(guildId, session);

    try {
      await session.start();
    } catch (err) {
      // Clean up if start() fails
      this.sessions.delete(guildId);
      throw err;
    }

    this.logger.info(
      `[SessionManager] Joined channel ${channelId} in guild ${guildId} (mode: ${session.engine.mode})`
    );

    return session;
  }

  /** Leave the voice channel for a guild. */
  async leave(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) {
      this.logger.warn(`[SessionManager] No active session for guild ${guildId}`);
      return;
    }

    this.sessions.delete(guildId);

    // Grab conversation history before stop (history survives stop but not GC)
    const history = session.engine.getConversationHistory();
    const engineMode = session.engine.mode;

    await session.stop();

    // In S2S mode the agent never sees the conversation during the session,
    // so dispatch a summary for its memory/context. Pipeline mode already
    // dispatches every turn via streamAgentResponse — no summary needed.
    if (engineMode === "speech-to-speech" && history.length > 0) {
      this.coreBridge.dispatchSessionSummary(engineMode, history).catch((err) => {
        this.logger.error(`[SessionManager] Session summary failed for guild ${guildId}:`, err);
      });
    }

    this.logger.info(`[SessionManager] Left voice channel in guild ${guildId}`);
  }

  /** Get an active session for a guild (or undefined if not active). */
  getSession(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  /** List all active guild IDs. */
  getActiveGuilds(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Stop all active sessions and destroy the shared Discord client.
   * Call this during plugin shutdown.
   */
  async stopAll(): Promise<void> {
    const guildIds = [...this.sessions.keys()];

    await Promise.allSettled(guildIds.map((id) => this.leave(id)));

    // Destroy the shared Discord client after all sessions are gone
    await destroyDiscordClient();

    this.logger.info("[SessionManager] All sessions stopped");
  }
}
