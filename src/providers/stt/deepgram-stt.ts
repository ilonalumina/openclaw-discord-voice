import { createClient, type DeepgramClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { EventEmitter } from "node:events";
import type { SttProvider, SttStream, SttStreamOptions, SttBatchOptions, SttResult } from "../../types.js";
import type { ResolvedDeepgramConfig } from "../../types.js";
import { DEEPGRAM_PING_INTERVAL_MS } from "../../constants.js";

/**
 * Deepgram Nova-3 streaming STT provider.
 * Opens a WebSocket to Deepgram for real-time transcription (~200ms latency).
 * Falls back to batch transcription for short segments.
 */
export class DeepgramStt implements SttProvider {
  readonly id = "deepgram";
  readonly supportsStreaming = true;

  private client: DeepgramClient;
  private config: ResolvedDeepgramConfig;

  constructor(config: ResolvedDeepgramConfig) {
    this.config = config;
    this.client = createClient(config.apiKey);
  }

  startStream(options: SttStreamOptions): SttStream {
    return new DeepgramStream(this.client, this.config, options);
  }

  async transcribe(audio: Buffer, options: SttBatchOptions): Promise<SttResult> {
    const schema = {
      model: this.config.model,
      language: options.language ?? this.config.language,
      smart_format: this.config.smartFormatting,
      encoding: "linear16" as const,
      sample_rate: options.sampleRate,
      channels: 1,
      ...(this.config.keywords.length > 0 && { keywords: this.config.keywords }),
    };

    const { result, error } = await this.client.listen.prerecorded.transcribeFile(
      audio,
      schema
    );

    if (error) throw error;

    const alt = result?.results?.channels?.[0]?.alternatives?.[0];
    return {
      text: alt?.transcript ?? "",
      confidence: alt?.confidence,
      language: result?.results?.channels?.[0]?.detected_language,
      isFinal: true,
    };
  }

  async dispose(): Promise<void> {
    // DeepgramClient has no explicit destroy method
  }
}

// ── Streaming session ─────────────────────────────────────────────────────────

class DeepgramStream extends EventEmitter implements SttStream {
  private connection: ReturnType<DeepgramClient["listen"]["live"]> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private audioBuffer: Buffer[] = [];
  private connected = false;
  private closed = false;

  constructor(
    private client: DeepgramClient,
    private config: ResolvedDeepgramConfig,
    private options: SttStreamOptions
  ) {
    super();
    void this.connect();
  }

  write(pcm: Buffer): void {
    if (this.closed) return;
    const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    if (this.connected && this.connection) {
      this.connection.send(ab);
    } else {
      // Buffer audio until connected
      this.audioBuffer.push(pcm);
    }
  }

  end(): void {
    if (this.connection) {
      this.connection.requestClose();
    }
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    this.audioBuffer = [];
    if (this.connection) {
      this.connection.requestClose();
      this.connection = null;
    }
    this.removeAllListeners();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    try {
      this.connection = this.client.listen.live({
        model: this.config.model,
        language: this.config.language,
        smart_format: this.config.smartFormatting,
        encoding: "linear16" as const,
        sample_rate: this.options.sampleRate,
        channels: this.options.channels ?? 1,
        interim_results: true,
        endpointing: this.config.endpointing,
        vad_events: true,
        ...(this.config.keywords.length > 0 && { keywords: this.config.keywords }),
      });

      this.connection.on(LiveTranscriptionEvents.Open, () => {
        this.connected = true;

        // Flush buffered audio
        for (const chunk of this.audioBuffer) {
          const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
          this.connection!.send(ab);
        }
        this.audioBuffer = [];

        this.startPing();
      });

      this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const alt = data?.channel?.alternatives?.[0];
        if (!alt?.transcript) return;

        if (data.is_final) {
          this.emit("final", {
            text: alt.transcript,
            confidence: alt.confidence,
            language: data.channel.detected_language,
            isFinal: true,
          } satisfies SttResult);
        } else {
          this.emit("partial", alt.transcript);
        }
      });

      this.connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
        this.emit("speech-start");
      });

      this.connection.on(LiveTranscriptionEvents.Error, (err: Error) => {
        this.stopPing();
        this.emit("error", new Error(`Deepgram error: ${String(err).slice(0, 200)}`));
      });

      this.connection.on(LiveTranscriptionEvents.Close, () => {
        this.connected = false;
        this.stopPing();
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.connection && this.connected) {
        this.connection.keepAlive();
      }
    }, DEEPGRAM_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
