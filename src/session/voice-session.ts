import { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import type { VoiceSessionContext, SessionState } from "../types.js";
import { DiscordConnection, getDiscordClient } from "../discord/connection.js";
import { AudioReceiver } from "../discord/audio-receiver.js";
import { AudioSender } from "../discord/audio-sender.js";
import { AudioPipeline } from "../audio/audio-pipeline.js";
import { EchoSuppressor } from "../audio/echo-suppressor.js";
import { VoiceActivityDetector } from "../audio/vad.js";
import { createEngine } from "../engine/engine-factory.js";
import type { VoiceEngine } from "../engine/engine-interface.js";
import type { CoreBridge } from "../core-bridge.js";

/**
 * Per-guild voice session orchestrator.
 *
 * Wires together:
 *   Discord connection → AudioReceiver → EchoSuppressor → per-user VAD → VoiceEngine
 *   VoiceEngine → AudioSender → Discord channel
 *
 * Manages the session state machine:
 *   idle → listening → processing → speaking → listening → ...
 *
 * Handles:
 *   - Barge-in: user speech while bot is speaking interrupts the response
 *   - Echo suppression: bot's own audio is filtered from incoming audio
 *   - Per-user VAD: each user gets their own voice activity detector
 *   - Streaming audio playback: audio-out chunks are streamed to Discord via PassThrough
 */
export class VoiceSession extends EventEmitter {
  readonly guildId: string;
  readonly engine: VoiceEngine;

  private context: VoiceSessionContext;
  private discordConn: DiscordConnection;
  private audioPipeline: AudioPipeline;
  private audioSender: AudioSender | null = null;
  private audioReceiver: AudioReceiver | null = null;
  private echoSuppressor: EchoSuppressor;
  private userVads = new Map<string, VoiceActivityDetector>();
  private activeSpeakers = new Set<string>();
  private activePassthrough: PassThrough | null = null;
  private _state: SessionState = "idle";

  constructor(context: VoiceSessionContext, coreBridge: CoreBridge) {
    super();
    this.guildId = context.guildId;
    this.context = context;
    this.engine = createEngine(context.config, coreBridge);

    const client = getDiscordClient(context.config.discordToken);
    this.discordConn = new DiscordConnection(context.guildId, client);
    this.audioPipeline = new AudioPipeline();
    this.echoSuppressor = new EchoSuppressor();
  }

  get state(): SessionState {
    return this._state;
  }

  /** Join the configured voice channel and start the engine. */
  async start(): Promise<void> {
    const connection = await this.discordConn.join(this.context.channelId);

    this.audioSender = new AudioSender(connection, this.audioPipeline);
    this.audioReceiver = new AudioReceiver(
      connection,
      this.audioPipeline,
      this.context.config.behavior.allowedUsers,
      this.context.config.vad.silenceDurationMs
    );

    try {
      await this.engine.start(this.context);
    } catch (err) {
      // Clean up Discord resources if engine fails to start
      this.audioReceiver.dispose();
      this.audioSender.dispose();
      await this.discordConn.leave().catch(() => { /* ignore cleanup errors */ });
      throw err;
    }

    this.attachEngineEvents();
    this.attachReceiverEvents();

    this._state = "listening";
    this.emit("started");
  }

  /** Leave the voice channel and clean up all resources. */
  async stop(): Promise<void> {
    this._state = "idle";

    // End any active audio stream
    this.endCurrentStream();

    // Dispose per-user VADs
    const vadDisposals = [...this.userVads.values()].map((v) => v.dispose().catch(() => { /* ignore */ }));
    await Promise.all(vadDisposals);
    this.userVads.clear();
    this.activeSpeakers.clear();

    await this.engine.stop().catch((err) => {
      console.error(`[VoiceSession:${this.guildId}] Engine stop error:`, err);
    });

    this.audioReceiver?.dispose();
    this.audioSender?.dispose();

    await this.discordConn.leave().catch((err) => {
      console.error(`[VoiceSession:${this.guildId}] Discord leave error:`, err);
    });

    this.echoSuppressor.reset();
    this.emit("stopped");
    this.removeAllListeners();
  }

  /** Inject text for the engine to speak (e.g. from the CLI or agent tool). */
  async injectText(text: string): Promise<void> {
    await this.engine.injectText("system", text);
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private attachEngineEvents(): void {
    // audioSender is always set before attachEngineEvents is called (see start()),
    // but guard here for safety in case of future refactoring
    const sender = this.audioSender;
    if (!sender) return;

    this.engine.on("audio-out", (chunk: Buffer, sampleRate: number) => {
      this._state = "speaking";
      this.echoSuppressor.setSpeaking(true);
      this.echoSuppressor.registerOutbound(chunk);

      // Ensure a PassThrough stream is open for this response
      if (!this.activePassthrough) {
        this.activePassthrough = sender.createPassthrough();
        // New playback stream — clear the resampler's cross-chunk carry so it
        // doesn't bridge the silence gap between separate responses.
        this.audioPipeline.resetPlayback();
      }

      // Convert to Discord format (48kHz stereo). Streaming variant keeps the
      // resampler stateful across chunks so chunk boundaries don't click.
      const discord48k = this.audioPipeline.toDiscordFormatStreaming(chunk, sampleRate, 1);
      this.activePassthrough.write(discord48k);
    });

    this.engine.on("turn-end", () => {
      this.endCurrentStream();
      if (this._state === "speaking") {
        this._state = "listening";
      }
    });

    this.engine.on("transcript-in", (userId: string, text: string) => {
      if (this._state !== "speaking") {
        this._state = "processing";
      }
      this.emit("transcript-in", userId, text);
    });

    this.engine.on("transcript-out", (text: string) => {
      this.emit("transcript-out", text);
    });

    this.engine.on("error", (err: Error) => {
      console.error(`[VoiceSession:${this.guildId}] Engine error:`, err);
      this.emit("error", err);
    });

    // When the AudioPlayer goes idle, update speaking state
    sender.on("idle", () => {
      if (this._state === "speaking") {
        this._state = "listening";
        this.echoSuppressor.setSpeaking(false);
      }
    });
  }

  private attachReceiverEvents(): void {
    if (!this.audioReceiver) return;

    this.audioReceiver.on("packet", (userId: string, pcm16k: Buffer, sampleRate: number) => {
      // Echo suppression — drop packets likely to be the bot's own audio
      if (this.context.config.behavior.echoSuppression && this.echoSuppressor.shouldSuppress(pcm16k)) {
        return;
      }

      // Feed to per-user VAD
      this.getOrCreateVad(userId).process(pcm16k);

      // Feed raw audio to the engine (for S2S streaming or pipeline accumulation)
      this.engine.feedAudio(userId, pcm16k, sampleRate);
    });

    this.audioReceiver.on("user-speaking-start", (userId: string) => {
      this.activeSpeakers.add(userId);

      // Barge-in: interrupt bot if it's currently speaking
      if (this.context.config.behavior.bargeIn && this._state === "speaking") {
        this.handleBargeIn();
      }
    });

    this.audioReceiver.on("user-speaking-stop", (userId: string) => {
      this.activeSpeakers.delete(userId);

      // Discord ends the receive stream after a trailing silence (EndBehaviorType
      // .AfterSilence), which is our only reliable end-of-utterance signal: the VAD
      // can't detect silence because no audio frames arrive once the user stops, so
      // its "speech-end" never fires. Drive STT off this stream-end instead.
      this.engine.endOfSpeech(userId);
      if (this._state === "listening") {
        this._state = "processing";
      }
    });
  }

  private handleBargeIn(): void {
    this.engine.interrupt();
    this.endCurrentStream();
    this.audioSender?.stop();
    this.echoSuppressor.setSpeaking(false);
    this._state = "listening";
  }

  private endCurrentStream(): void {
    if (this.activePassthrough) {
      try {
        this.activePassthrough.end();
      } catch {
        // PassThrough may already be destroyed — ignore
      }
      this.activePassthrough = null;
    }
  }

  private getOrCreateVad(userId: string): VoiceActivityDetector {
    if (!this.userVads.has(userId)) {
      const vad = new VoiceActivityDetector(this.context.config.vad);

      // Initialize async — falls back to RMS if Silero fails to load
      void vad.init();

      vad.on("speech-end", () => {
        // Signal the engine that this user finished speaking
        this.engine.endOfSpeech(userId);
        if (this._state === "listening") {
          this._state = "processing";
        }
      });

      this.userVads.set(userId, vad);
    }
    return this.userVads.get(userId)!;
  }
}
