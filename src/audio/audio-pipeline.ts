// opusscript is a CJS default export — a single class used for both encoding/decoding
import OpusScript from "opusscript";
import {
  DISCORD_SAMPLE_RATE,
  PROCESSING_SAMPLE_RATE,
  DISCORD_CHANNELS,
  BYTES_PER_SAMPLE,
  OPUS_FRAME_DURATION_MS,
} from "../constants.js";

/**
 * Handles all audio format conversions between Discord's 48kHz stereo Opus
 * and the 16kHz mono PCM needed by STT/VAD, and vice versa for playback.
 *
 * One instance per VoiceSession.
 */
export class AudioPipeline {
  private opus: InstanceType<typeof OpusScript>;
  private playbackResampler: StreamResampler | null = null;
  // Capture-side stateful resamplers, one per speaking user. Discord delivers
  // 20ms Opus packets (50/s); per-packet stateless resampling left a seam at
  // every packet boundary — 50 micro-discontinuities per second fed to the
  // STT, audible as garble and causing mistranscription. The playback
  // direction uses the same stateful fix.
  private captureResamplers = new Map<string, StreamResampler>();

  constructor() {
    // Discord sends/expects stereo Opus at 48kHz
    this.opus = new OpusScript(DISCORD_SAMPLE_RATE, DISCORD_CHANNELS, OpusScript.Application.VOIP);
  }

  /**
   * Decode a Discord Opus packet and downsample to 16kHz mono PCM
   * for use with VAD and STT providers. Resampling state is carried across
   * packets per user — call resetCapture(userId) at utterance end.
   */
  decodeForProcessing(opusPacket: Buffer, userId = "default"): Buffer {
    const pcm48kStereo = Buffer.from(this.opus.decode(opusPacket));
    const mono48k = this.stereoToMonoPcm(pcm48kStereo);
    let rs = this.captureResamplers.get(userId);
    if (!rs) {
      rs = new StreamResampler(DISCORD_SAMPLE_RATE, PROCESSING_SAMPLE_RATE);
      this.captureResamplers.set(userId, rs);
    }
    return rs.process(mono48k);
  }

  /** Drop a user's capture resampler state — call when their utterance ends. */
  resetCapture(userId: string): void {
    this.captureResamplers.delete(userId);
  }

  /**
   * Encode 16-bit PCM (any sample rate, mono or stereo) to 48kHz stereo Opus
   * for Discord playback.
   */
  encodeForPlayback(pcm: Buffer, inputSampleRate: number, inputChannels = 1): Buffer {
    const pcm48kStereo = this.toDiscordFormat(pcm, inputSampleRate, inputChannels);
    return Buffer.from(this.opus.encode(pcm48kStereo, OPUS_FRAME_SIZE_SAMPLES));
  }

  /**
   * Upsample PCM from any rate/channels to 48kHz stereo for Discord.
   * Returns a Buffer of 16-bit little-endian PCM.
   */
  toDiscordFormat(pcm: Buffer, inputSampleRate: number, inputChannels = 1): Buffer {
    let mono = inputChannels === 1 ? pcm : this.stereoToMonoPcm(pcm);
    if (inputSampleRate !== DISCORD_SAMPLE_RATE) {
      mono = resample(mono, inputSampleRate, DISCORD_SAMPLE_RATE);
    }
    return monoToStereo(mono);
  }

  /** Reset the streaming playback resampler — call at the start of each TTS stream. */
  resetPlayback(): void {
    this.playbackResampler = null;
  }

  /**
   * Streaming variant of toDiscordFormat for continuous TTS playback. Uses a
   * persistent resampler that carries interpolation state across chunks, so there
   * is no discontinuity (audible click) at the boundary between TTS chunks.
   */
  toDiscordFormatStreaming(pcm: Buffer, inputSampleRate: number, inputChannels = 1): Buffer {
    let mono = inputChannels === 1 ? pcm : this.stereoToMonoPcm(pcm);
    if (inputSampleRate !== DISCORD_SAMPLE_RATE) {
      if (!this.playbackResampler || this.playbackResampler.fromRate !== inputSampleRate) {
        this.playbackResampler = new StreamResampler(inputSampleRate, DISCORD_SAMPLE_RATE);
      }
      mono = this.playbackResampler.process(mono);
    }
    return monoToStereo(mono);
  }

  /**
   * Downsample from any rate/channels to 16kHz mono for processing.
   */
  toProcessingFormat(pcm: Buffer, inputSampleRate: number, inputChannels = 2): Buffer {
    let mono = inputChannels === 1 ? pcm : this.stereoToMonoPcm(pcm);
    if (inputSampleRate !== PROCESSING_SAMPLE_RATE) {
      mono = resample(mono, inputSampleRate, PROCESSING_SAMPLE_RATE);
    }
    return mono;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /** Average stereo channels to mono (16-bit PCM) */
  private stereoToMonoPcm(stereo: Buffer): Buffer {
    // floor so a buffer that isn't a whole number of stereo frames can't drive a
    // read past the end (Discord capture chunks aren't guaranteed 4-byte aligned).
    const samples = Math.floor(stereo.length / BYTES_PER_SAMPLE / DISCORD_CHANNELS);
    const mono = Buffer.allocUnsafe(samples * BYTES_PER_SAMPLE);
    for (let i = 0; i < samples; i++) {
      const l = stereo.readInt16LE(i * 4);
      const r = stereo.readInt16LE(i * 4 + 2);
      mono.writeInt16LE(Math.round((l + r) / 2), i * 2);
    }
    return mono;
  }

  dispose(): void {
    this.opus.delete();
  }
}

// ── Utility: simple linear interpolation resampler ────────────────────────────

/**
 * Resample 16-bit mono PCM from one sample rate to another.
 * Uses linear interpolation — good enough for voice; no heavy native deps.
 */
export function resample(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;

  // floor: an odd-length buffer must not yield a fractional sample count, or the
  // srcIdx < inSamples guard below would admit a read one Int16 past the end.
  const inSamples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const ratio = fromRate / toRate;
  const outSamples = Math.round(inSamples / ratio);
  const out = Buffer.allocUnsafe(outSamples * BYTES_PER_SAMPLE);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const a = srcIdx < inSamples ? pcm.readInt16LE(srcIdx * BYTES_PER_SAMPLE) : 0;
    const b = srcIdx + 1 < inSamples ? pcm.readInt16LE((srcIdx + 1) * BYTES_PER_SAMPLE) : a;

    out.writeInt16LE(Math.round(a + frac * (b - a)), i * BYTES_PER_SAMPLE);
  }

  return out;
}

/** Duplicate mono samples to stereo (16-bit PCM) */
export function monoToStereo(mono: Buffer): Buffer {
  const samples = Math.floor(mono.length / BYTES_PER_SAMPLE);
  const stereo = Buffer.allocUnsafe(samples * BYTES_PER_SAMPLE * DISCORD_CHANNELS);
  for (let i = 0; i < samples; i++) {
    const val = mono.readInt16LE(i * BYTES_PER_SAMPLE);
    stereo.writeInt16LE(val, i * 4);
    stereo.writeInt16LE(val, i * 4 + 2);
  }
  return stereo;
}

/**
 * Streaming linear resampler for 16-bit mono PCM. Unlike the stateless `resample`
 * above, it carries the previous input sample and fractional read position across
 * calls, so interpolation is continuous from one chunk to the next. Per-chunk
 * stateless resampling leaves a discontinuity at every chunk boundary — audible as
 * clicks, especially with a TTS source (GPU Kokoro) that emits many small bursts.
 * Create one per playback stream and reset it (new instance) at the start of each.
 */
export class StreamResampler {
  readonly fromRate: number;
  private readonly step: number;   // input samples advanced per output sample
  private prev = 0;                 // last input sample, carried across chunks
  private primed = false;
  private frac = 0;                 // fractional position within [prev, next)

  constructor(fromRate: number, toRate: number) {
    this.fromRate = fromRate;
    this.step = fromRate / toRate;
  }

  process(pcm: Buffer): Buffer {
    const inSamples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
    if (inSamples === 0) return Buffer.alloc(0);

    const out: number[] = [];
    let i = 0;
    if (!this.primed) {
      this.prev = pcm.readInt16LE(0);
      this.primed = true;
      this.frac = 0;
      i = 1;
    }
    for (; i < inSamples; i++) {
      const next = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
      while (this.frac < 1) {
        out.push(this.prev + this.frac * (next - this.prev));
        this.frac += this.step;
      }
      this.frac -= 1;
      this.prev = next;
    }

    const buf = Buffer.allocUnsafe(out.length * BYTES_PER_SAMPLE);
    for (let k = 0; k < out.length; k++) {
      let v = Math.round(out[k]);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      buf.writeInt16LE(v, k * BYTES_PER_SAMPLE);
    }
    return buf;
  }
}

/** Samples per Opus frame at 48kHz */
const OPUS_FRAME_SIZE_SAMPLES =
  (DISCORD_SAMPLE_RATE * OPUS_FRAME_DURATION_MS) / 1000;

/** Calculate the expected PCM byte length for one 20ms Opus frame at 48kHz stereo */
export function opusFrameByteLength(): number {
  return OPUS_FRAME_SIZE_SAMPLES * DISCORD_CHANNELS * BYTES_PER_SAMPLE;
}
