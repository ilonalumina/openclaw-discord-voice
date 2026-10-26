import { EventEmitter } from "node:events";
import type { AudioSender } from "../discord/audio-sender.js";
import type { EchoSuppressor } from "./echo-suppressor.js";
import type { TtsStream } from "../types.js";

/**
 * Sequential playback queue for TTS audio streams.
 *
 * Guarantees:
 *   - Sentences play in order even when TTS synthesis overlaps
 *   - Barge-in (clear()) immediately stops current audio and drops the queue
 *   - Echo suppressor is notified before each audio chunk goes out
 *
 * Emits:
 *   "playing"  — first audio chunk of a new entry started
 *   "finished" — all queued entries have played
 *   "cleared"  — queue was cleared due to barge-in
 */
export class PlaybackQueue extends EventEmitter {
  private queue: QueueEntry[] = [];
  private currentEntry: QueueEntry | null = null;
  private sender: AudioSender;
  private echoSuppressor: EchoSuppressor;
  private draining = false;

  constructor(sender: AudioSender, echoSuppressor: EchoSuppressor) {
    super();
    this.sender = sender;
    this.echoSuppressor = echoSuppressor;

    this.sender.on("idle", () => {
      if (this.draining) return;
      this.currentEntry = null;
      this.processNext();
    });
  }

  /**
   * Enqueue a TTS stream for playback.
   * Streams play in the order they are enqueued.
   */
  enqueue(stream: TtsStream): void {
    const entry: QueueEntry = {
      stream,
      audioChunks: [],
      sampleRate: 24_000,
      ready: false,
      playPointer: 0,
    };

    // Collect chunks as they arrive from the TTS stream
    stream.on("audio", (chunk: Buffer, rate: number) => {
      entry.sampleRate = rate;
      entry.audioChunks.push(chunk);
      // If this entry is currently playing, keep feeding
      if (this.currentEntry === entry) {
        this.feedChunk(entry, chunk, rate);
      }
    });

    stream.once("end", () => {
      entry.ready = true;
    });

    stream.once("error", (err: Error) => {
      entry.error = err;
      entry.ready = true;
      if (this.currentEntry === entry) {
        this.currentEntry = null;
        this.processNext();
      } else {
        this.removeEntry(entry);
      }
    });

    this.queue.push(entry);
    this.processNext();
  }

  /**
   * Clear all queued and current playback immediately.
   * Used for barge-in: bot stops speaking so user can be heard.
   */
  clear(): void {
    this.draining = true;

    // Cancel all pending streams
    for (const entry of this.queue) {
      entry.stream.cancel();
    }
    this.queue = [];

    if (this.currentEntry) {
      this.currentEntry.stream.cancel();
      this.currentEntry = null;
    }

    this.sender.stop();
    this.echoSuppressor.setSpeaking(false);
    this.emit("cleared");
    this.draining = false;
  }

  get isPlaying(): boolean {
    return this.currentEntry !== null || this.queue.length > 0;
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private processNext(): void {
    if (this.draining) return;
    if (this.currentEntry !== null) return;
    if (this.queue.length === 0) {
      this.echoSuppressor.setSpeaking(false);
      this.emit("finished");
      return;
    }

    this.currentEntry = this.queue.shift()!;

    if (this.currentEntry.error) {
      const err = this.currentEntry.error;
      this.currentEntry = null;
      this.emit("error", err);
      this.processNext();
      return;
    }

    this.echoSuppressor.setSpeaking(true);
    this.emit("playing");

    // Play any chunks already buffered
    for (const chunk of this.currentEntry.audioChunks) {
      this.feedChunk(this.currentEntry, chunk, this.currentEntry.sampleRate);
    }
    this.currentEntry.playPointer = this.currentEntry.audioChunks.length;

    // If the stream already ended and no chunks, move on
    if (this.currentEntry.ready && this.currentEntry.audioChunks.length === 0) {
      this.currentEntry = null;
      this.processNext();
    }
  }

  private feedChunk(_entry: QueueEntry, chunk: Buffer, sampleRate: number): void {
    this.echoSuppressor.registerOutbound(chunk);
    this.sender.playBuffer(chunk, sampleRate, 1);
  }

  private removeEntry(entry: QueueEntry): void {
    const idx = this.queue.indexOf(entry);
    if (idx !== -1) this.queue.splice(idx, 1);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueEntry {
  stream: TtsStream;
  audioChunks: Buffer[];
  sampleRate: number;
  ready: boolean;
  playPointer: number;
  error?: Error;
}
