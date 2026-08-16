import { EventEmitter } from "node:events";
import type { TtsProvider, TtsStream, TtsResult, TtsOptions } from "../../types.js";
import type { ResolvedKokoroConfig } from "../../types.js";

type KokoroInstance = {
  generate: (text: string, options: { voice: string; speed: number }) => Promise<{ audio: Float32Array; sampleRate: number }>;
};

/**
 * Kokoro local ONNX TTS provider.
 * Fully offline — no API key required, no data leaves the machine.
 * Loads the model once on first use and caches it (singleton pattern).
 * ~300ms latency (ONNX inference), 54 voices available.
 */
export class KokoroTts implements TtsProvider {
  readonly id = "kokoro";
  readonly supportsStreaming = false;

  private config: ResolvedKokoroConfig;
  private static instance: KokoroInstance | null = null;
  private static initPromise: Promise<KokoroInstance> | null = null;

  constructor(config: ResolvedKokoroConfig) {
    this.config = config;
  }

  synthesizeStream(text: string, options?: TtsOptions): TtsStream {
    const stream = new KokoroTtsStream();
    void stream.start(this.getOrInitKokoro.bind(this), text, this.config, options);
    return stream;
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    const kokoro = await this.getOrInitKokoro();
    const result = await kokoro.generate(text, {
      voice: this.config.voiceId,
      speed: options?.speed ?? this.config.speed,
    });

    return {
      audio: float32ToPcm16(result.audio),
      sampleRate: result.sampleRate,
      format: "pcm",
    };
  }

  async dispose(): Promise<void> {}

  private async getOrInitKokoro(): Promise<KokoroInstance> {
    if (KokoroTts.instance) return KokoroTts.instance;

    if (!KokoroTts.initPromise) {
      KokoroTts.initPromise = (async () => {
        const { KokoroTTS } = await import("kokoro-js");
        const model = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX");
        KokoroTts.instance = model as unknown as KokoroInstance;
        return KokoroTts.instance;
      })();
    }

    return KokoroTts.initPromise;
  }
}

// ── Streaming wrapper (batch under the hood) ──────────────────────────────────

class KokoroTtsStream extends EventEmitter implements TtsStream {
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    this.emit("end");
    this.removeAllListeners();
  }

  async start(
    getKokoro: () => Promise<KokoroInstance>,
    text: string,
    config: ResolvedKokoroConfig,
    options?: TtsOptions
  ): Promise<void> {
    try {
      const kokoro = await getKokoro();
      if (this.cancelled) return;

      const result = await kokoro.generate(text, {
        voice: config.voiceId,
        speed: options?.speed ?? config.speed,
      });

      if (!this.cancelled) {
        this.emit("audio", float32ToPcm16(result.audio), result.sampleRate);
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

// ── Utility ───────────────────────────────────────────────────────────────────

function float32ToPcm16(float32: Float32Array): Buffer {
  const pcm = Buffer.allocUnsafe(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]!));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return pcm;
}
