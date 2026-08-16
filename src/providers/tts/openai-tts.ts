import { EventEmitter } from "node:events";
import type { TtsProvider, TtsStream, TtsOptions } from "../../types.js";
import type { ResolvedOpenAiTtsConfig } from "../../types.js";

/** OpenAI TTS provider via REST streaming (~250ms TTFB). */
export class OpenAiTts implements TtsProvider {
  readonly id = "openai";
  readonly supportsStreaming = true;

  private config: ResolvedOpenAiTtsConfig;

  constructor(config: ResolvedOpenAiTtsConfig) {
    this.config = config;
  }

  synthesizeStream(text: string, options?: TtsOptions): TtsStream {
    const stream = new OpenAiTtsStream();
    void stream.start(text, this.config, options);
    return stream;
  }

  async dispose(): Promise<void> {}
}

// ── Streaming session ─────────────────────────────────────────────────────────

class OpenAiTtsStream extends EventEmitter implements TtsStream {
  private cancelled = false;
  private abortController = new AbortController();

  cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
    this.emit("end");
    this.removeAllListeners();
  }

  async start(text: string, config: ResolvedOpenAiTtsConfig, options?: TtsOptions): Promise<void> {
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          voice: config.voice,
          input: text,
          response_format: "pcm",
          speed: options?.speed ?? config.speed,
          // Generation-streaming: servers that accept `stream: true` emit
          // audio chunks as the model produces them. Note: some such servers
          // document float32 output but actually send int16 on the wire —
          // this path assumes int16 PCM (float32 decode of an int16 stream
          // yields full-scale garbage).
          ...(config.streamPcm ? { stream: true } : {}),
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "unknown");
        throw new Error(`OpenAI TTS error ${response.status}: ${err.slice(0, 200)}`);
      }

      if (!response.body) throw new Error("OpenAI TTS: empty response body");

      const reader = response.body.getReader();
      // PCM is 16-bit, so every sample is 2 bytes. A streamed chunk can end on an
      // odd byte (a sample split across two network reads); emitting it as-is hands
      // a sample-misaligned, odd-length buffer to the resampler, which reads one
      // Int16 past the end (RangeError) and, if merely truncated, byte-shifts all
      // following samples into static. Carry the trailing odd byte into the next
      // chunk so every emitted buffer is sample-aligned (even length).
      let leftover = Buffer.alloc(0);
      try {
        while (!this.cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            const buf = leftover.length
              ? Buffer.concat([leftover, Buffer.from(value)])
              : Buffer.from(value);
            const evenLen = buf.length - (buf.length % 2);
            leftover = evenLen < buf.length ? buf.subarray(evenLen) : Buffer.alloc(0);
            if (evenLen > 0) {
              // 24kHz mono 16-bit PCM in both modes (batch and
              // generation-streaming)
              this.emit("audio", buf.subarray(0, evenLen), 24_000);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!this.cancelled) {
        this.emit("end");
      }
    } catch (err) {
      if (!this.cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.removeAllListeners();
    }
  }
}
