import { EndBehaviorType, type VoiceConnection, type VoiceReceiver } from "@discordjs/voice";
import { EventEmitter } from "node:events";
import type { AudioPipeline } from "../audio/audio-pipeline.js";
import { PROCESSING_SAMPLE_RATE } from "../constants.js";

/**
 * Subscribes to all users' audio streams in a voice connection and emits
 * decoded 16kHz mono PCM packets for downstream processing.
 *
 * Handles per-user stream lifecycle automatically.
 *
 * Emits:
 *   "packet"              (userId: string, pcm16k: Buffer, sampleRate: number)
 *   "user-speaking-start" (userId: string)
 *   "user-speaking-stop"  (userId: string)
 */
export class AudioReceiver extends EventEmitter {
  private connection: VoiceConnection;
  private pipeline: AudioPipeline;
  private activeStreams = new Map<string, boolean>();
  private allowedUsers: Set<string>;
  private silenceDurationMs: number;

  constructor(
    connection: VoiceConnection,
    pipeline: AudioPipeline,
    allowedUsers: string[] = [],
    silenceDurationMs = 1_500
  ) {
    super();
    this.connection = connection;
    this.pipeline = pipeline;
    this.allowedUsers = new Set(allowedUsers);
    this.silenceDurationMs = silenceDurationMs;
    this.attachReceiver();
  }

  /** Update the list of allowed users (empty = allow all). */
  setAllowedUsers(userIds: string[]): void {
    this.allowedUsers = new Set(userIds);
  }

  dispose(): void {
    this.removeAllListeners();
    this.activeStreams.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private attachReceiver(): void {
    const receiver: VoiceReceiver = this.connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (this.isBlocked(userId)) return;
      if (this.activeStreams.has(userId)) return;

      this.activeStreams.set(userId, true);
      this.emit("user-speaking-start", userId);
      this.subscribeUser(receiver, userId);
    });
  }

  private subscribeUser(receiver: VoiceReceiver, userId: string): void {
    const stream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.silenceDurationMs,
      },
    });

    stream.on("data", (opusPacket: Buffer) => {
      try {
        const pcm16k = this.pipeline.decodeForProcessing(opusPacket, userId);
        this.emit("packet", userId, pcm16k, PROCESSING_SAMPLE_RATE);
      } catch {
        // Corrupted packet — skip silently
      }
    });

    stream.once("end", () => {
      this.activeStreams.delete(userId);
      this.pipeline.resetCapture(userId);
      this.emit("user-speaking-stop", userId);
    });

    stream.once("error", () => {
      this.activeStreams.delete(userId);
    });
  }

  private isBlocked(userId: string): boolean {
    if (this.allowedUsers.size === 0) return false;
    return !this.allowedUsers.has(userId);
  }
}
