import { ElevenLabsClient } from "elevenlabs";
import { EventEmitter } from "node:events";
import type { TtsProvider, TtsStream, TtsOptions } from "../../types.js";
import type { ResolvedElevenLabsConfig } from "../../types.js";

/** ElevenLabs Flash v2.5 streaming TTS provider (~75ms TTFB). */
export class ElevenLabsTts implements TtsProvider {
  readonly id = "elevenlabs";
  readonly supportsStreaming = true;

  private client: ElevenLabsClient;
  private config: ResolvedElevenLabsConfig;

  constructor(config: ResolvedElevenLabsConfig) {
    this.config = config;
    this.client = new ElevenLabsClient({ apiKey: config.apiKey });
  }

  synthesizeStream(text: string, options?: TtsOptions): TtsStream {
    const stream = new ElevenLabsTtsStream();
    void stream.start(this.client, text, this.config, options);
    return stream;
  }

  async dispose(): Promise<void> {}
}

// ── Streaming session ─────────────────────────────────────────────────────────

class ElevenLabsTtsStream extends EventEmitter implements TtsStream {
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    this.emit("end");
    this.removeAllListeners();
  }

  async start(
    client: ElevenLabsClient,
    text: string,
    config: ResolvedElevenLabsConfig,
    _options?: TtsOptions
  ): Promise<void> {
    try {
      const audioStream = await client.textToSpeech.convertAsStream(config.voiceId, {
        text,
        model_id: config.model,
        output_format: "pcm_44100",
        voice_settings: {
          stability: config.stability,
          similarity_boost: config.similarityBoost,
        },
      });

      for await (const chunk of audioStream) {
        if (this.cancelled) break;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
        this.emit("audio", buf, 44_100);
      }

      if (!this.cancelled) {
        this.emit("end");
      }
    } catch (err) {
      if (!this.cancelled) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.removeAllListeners();
    }
  }
}
