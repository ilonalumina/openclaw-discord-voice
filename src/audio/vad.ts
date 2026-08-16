import { RealTimeVAD } from "avr-vad";
import { EventEmitter } from "node:events";
import type { ResolvedVadConfig } from "../types.js";
import { BYTES_PER_SAMPLE } from "../constants.js";

/**
 * Voice Activity Detector.
 *
 * Supports two engines:
 *   - "silero": Deep learning VAD via avr-vad (Silero v5 ONNX model). Recommended.
 *   - "rms":    Simple RMS energy threshold. Zero deps, lower accuracy.
 *
 * Both engines emit "speech-start" and "speech-end" events.
 * Audio input must be 16kHz mono 16-bit PCM (output of AudioPipeline.decodeForProcessing).
 *
 * Emits:
 *   "speech-start"  — user started speaking
 *   "speech-end"    — user stopped speaking
 */
export class VoiceActivityDetector extends EventEmitter {
  private config: ResolvedVadConfig;
  private engine: "silero" | "rms";

  // Silero state
  private sileroVad: RealTimeVAD | null = null;
  private initPromise: Promise<void> | null = null;

  // RMS state
  private rmsSpeaking = false;
  private rmsLastSpeechTime = 0;

  constructor(config: ResolvedVadConfig) {
    super();
    this.config = config;
    this.engine = config.engine;
  }

  /** Initialize the VAD (async for Silero model loading). Safe to call multiple times. */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.engine === "silero" ? this.initSilero() : Promise.resolve();
    await this.initPromise;
  }

  /**
   * Process a chunk of 16kHz mono PCM.
   * Events are emitted asynchronously via "speech-start" and "speech-end".
   */
  process(pcm: Buffer): void {
    if (this.engine === "silero" && this.sileroVad) {
      this.processSilero(pcm).catch((err) => {
        console.warn("[VAD] Silero processing error, falling back to RMS:", err);
        this.engine = "rms";
        this.processRms(pcm);
      });
    } else {
      this.processRms(pcm);
    }
  }

  reset(): void {
    this.rmsSpeaking = false;
    this.rmsLastSpeechTime = 0;
    if (this.sileroVad) {
      this.sileroVad.reset();
    }
  }

  async dispose(): Promise<void> {
    // Wait for any in-progress initialization before destroying
    if (this.initPromise) {
      await this.initPromise.catch(() => { /* ignore init errors on dispose */ });
    }
    if (this.sileroVad) {
      this.sileroVad.destroy();
      this.sileroVad = null;
    }
    this.removeAllListeners();
  }

  // ── Silero engine ─────────────────────────────────────────────────────────────

  private async initSilero(): Promise<void> {
    try {
      this.sileroVad = await RealTimeVAD.new({
        positiveSpeechThreshold: this.config.threshold,
        negativeSpeechThreshold: Math.max(0.1, this.config.threshold - 0.15),
        redemptionFrames: Math.round(
          (this.config.silenceDurationMs / 1000) * (16_000 / 512)
        ),
        minSpeechFrames: Math.round(
          (this.config.minSpeechDurationMs / 1000) * (16_000 / 512)
        ),
        onSpeechStart: () => {
          this.emit("speech-start");
        },
        onSpeechEnd: () => {
          this.emit("speech-end");
        },
        onVADMisfire: () => { /* false positive — ignore */ },
        onFrameProcessed: () => { /* per-frame — not needed */ },
        onSpeechRealStart: () => { /* pre-speech — not needed */ },
      });

      this.sileroVad.start();
    } catch (err) {
      console.warn("[VAD] Failed to initialize Silero VAD, falling back to RMS:", err);
      this.engine = "rms";
    }
  }

  private async processSilero(pcm: Buffer): Promise<void> {
    if (!this.sileroVad) return;

    const samples = pcm.length / BYTES_PER_SAMPLE;
    const float32 = new Float32Array(samples);

    // Convert 16-bit PCM → Float32 normalized [-1, 1]
    for (let i = 0; i < samples; i++) {
      float32[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    }

    await this.sileroVad.processAudio(float32);
  }

  // ── RMS fallback engine ───────────────────────────────────────────────────────

  private processRms(pcm: Buffer): void {
    const rms = calculateRms(pcm);
    const now = Date.now();
    // Scale config threshold (0-1) to PCM int16 range
    const threshold = this.config.threshold * 1600;
    const isSpeech = rms > threshold;

    if (isSpeech) {
      this.rmsLastSpeechTime = now;
      if (!this.rmsSpeaking) {
        this.rmsSpeaking = true;
        this.emit("speech-start");
      }
    } else if (this.rmsSpeaking) {
      const silenceDuration = now - this.rmsLastSpeechTime;
      if (silenceDuration >= this.config.silenceDurationMs) {
        this.rmsSpeaking = false;
        this.emit("speech-end");
      }
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Calculate RMS energy of a 16-bit PCM buffer */
function calculateRms(pcm: Buffer): number {
  const samples = pcm.length / BYTES_PER_SAMPLE;
  if (samples === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}
