import { EventEmitter } from "node:events";
import type { SttProvider, SttBatchOptions, SttResult } from "../../types.js";
import type { ResolvedWhisperConfig } from "../../types.js";

/**
 * OpenAI Whisper batch STT provider.
 * Transcribes a complete audio buffer via the OpenAI API.
 * Used as a fallback when streaming STT is unavailable.
 */
export class WhisperStt implements SttProvider {
  readonly id = "whisper";
  readonly supportsStreaming = false;

  private config: ResolvedWhisperConfig;

  constructor(config: ResolvedWhisperConfig) {
    this.config = config;
  }

  async transcribe(audio: Buffer, options: SttBatchOptions): Promise<SttResult> {
    const wav = pcmToWav(audio, options.sampleRate);

    const formData = new FormData();
    const wavAb = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    formData.append("file", new Blob([wavAb], { type: "audio/wav" }), "audio.wav");
    formData.append("model", this.config.model);
    if (this.config.language ?? options.language) {
      formData.append("language", this.config.language ?? options.language ?? "en");
    }
    formData.append("response_format", "json");

    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      throw new Error(`Whisper API error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json() as { text: string };
    return { text: data.text.trim(), isFinal: true };
  }

  async dispose(): Promise<void> {}
}

// ── WAV encoding ──────────────────────────────────────────────────────────────

/** Convert 16-bit mono PCM to a minimal WAV buffer. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataLength = pcm.length;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const wav = Buffer.allocUnsafe(totalLength);
  let offset = 0;

  const write = (str: string) => {
    wav.write(str, offset, "ascii");
    offset += str.length;
  };
  const writeUInt32LE = (val: number) => { wav.writeUInt32LE(val, offset); offset += 4; };
  const writeUInt16LE = (val: number) => { wav.writeUInt16LE(val, offset); offset += 2; };

  write("RIFF");
  writeUInt32LE(totalLength - 8);
  write("WAVE");
  write("fmt ");
  writeUInt32LE(16);           // Subchunk1Size (PCM)
  writeUInt16LE(1);            // AudioFormat (PCM = 1)
  writeUInt16LE(numChannels);
  writeUInt32LE(sampleRate);
  writeUInt32LE(byteRate);
  writeUInt16LE(blockAlign);
  writeUInt16LE(bitsPerSample);
  write("data");
  writeUInt32LE(dataLength);

  pcm.copy(wav, offset);
  return wav;
}

// WhisperStt does not support streaming — export a no-op stream class for interface compliance
export class WhisperSttStream extends EventEmitter {
  write(_pcm: Buffer): void {}
  end(): void {}
  close(): void { this.removeAllListeners(); }
}
