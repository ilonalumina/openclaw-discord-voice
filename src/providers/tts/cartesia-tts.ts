import { CartesiaClient } from "@cartesia/cartesia-js";
import { EventEmitter } from "node:events";
import type { TtsProvider, TtsStream, TtsOptions } from "../../types.js";
import type { ResolvedCartesiaConfig } from "../../types.js";

/** Cartesia Sonic-2 streaming TTS provider (~40ms TTFB via WebSocket). */
export class CartesiaTts implements TtsProvider {
  readonly id = "cartesia";
  readonly supportsStreaming = true;

  private client: CartesiaClient;
  private config: ResolvedCartesiaConfig;

  constructor(config: ResolvedCartesiaConfig) {
    this.config = config;
    this.client = new CartesiaClient({ apiKey: config.apiKey });
  }

  synthesizeStream(text: string, options?: TtsOptions): TtsStream {
    const stream = new CartesiaTtsStream();
    void stream.start(this.client, text, this.config, options);
    return stream;
  }

  async dispose(): Promise<void> {}
}

// ── Streaming session ─────────────────────────────────────────────────────────

class CartesiaTtsStream extends EventEmitter implements TtsStream {
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    this.emit("end");
    this.removeAllListeners();
  }

  async start(
    client: CartesiaClient,
    text: string,
    config: ResolvedCartesiaConfig,
    options?: TtsOptions
  ): Promise<void> {
    try {
      // bytes() returns a Node.js Readable stream of raw PCM bytes
      const readable = await client.tts.bytes({
        modelId: config.model,
        voice: { mode: "id", id: config.voiceId },
        transcript: text,
        outputFormat: {
          container: "raw",
          encoding: "pcm_s16le",
          sampleRate: 24_000,
        },
        ...(options?.speed != null && { speed: speedToCartesia(options.speed) }),
      });

      for await (const chunk of readable) {
        if (this.cancelled) break;
        this.emit("audio", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer), 24_000);
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function speedToCartesia(speed: number): "slow" | "normal" | "fast" {
  if (speed <= 0.8) return "slow";
  if (speed <= 1.3) return "normal";
  return "fast";
}
