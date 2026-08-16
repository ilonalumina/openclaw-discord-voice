import type { EventEmitter } from "node:events";
import type { ConversationTurn, EngineMode, VoiceSessionContext } from "../types.js";

/**
 * Shared contract for both PipelineEngine (STT→LLM→TTS)
 * and SpeechToSpeechEngine (OpenAI Realtime / Gemini Live).
 *
 * All audio in/out is 16-bit PCM. Sample rate is passed alongside audio.
 * Implementations handle all internal format conversions.
 */
export interface VoiceEngine extends EventEmitter {
  readonly mode: EngineMode;

  /** Start the engine and prepare for audio input. */
  start(session: VoiceSessionContext): Promise<void>;

  /**
   * Feed a chunk of decoded PCM from a user.
   * Called continuously while the user is speaking.
   */
  feedAudio(userId: string, pcm: Buffer, sampleRate: number): void;

  /**
   * Signal that the user has stopped speaking (VAD end-of-speech).
   * Pipeline engines use this to finalize STT. S2S engines may ignore it
   * if the provider handles VAD natively.
   */
  endOfSpeech(userId: string): void;

  /**
   * Inject a text message for the engine to respond to.
   * Used for programmatic speech (e.g., the `voice speak` command).
   */
  injectText(userId: string, text: string): Promise<void>;

  /**
   * Interrupt the current response immediately (barge-in).
   * Stops ongoing TTS playback and cancels in-flight requests.
   */
  interrupt(): void;

  /** Get the conversation history for this session. */
  getConversationHistory(): readonly ConversationTurn[];

  /** Stop the engine and clean up all resources. */
  stop(): Promise<void>;

  // ── Events ──────────────────────────────────────────────────────────────────

  /** Emitted when the engine has audio to play back to the channel. */
  on(event: "audio-out", handler: (audio: Buffer, sampleRate: number) => void): this;

  /** Emitted when a user's speech is transcribed (pipeline mode). */
  on(event: "transcript-in", handler: (userId: string, text: string) => void): this;

  /** Emitted when the assistant's response is transcribed. */
  on(event: "transcript-out", handler: (text: string) => void): this;

  /** Emitted on recoverable and fatal errors. */
  on(event: "error", handler: (error: Error) => void): this;

  /** Emitted when the engine finishes a complete response turn. */
  on(event: "turn-end", handler: () => void): this;

  on(event: string, handler: (...args: unknown[]) => void): this;
}
