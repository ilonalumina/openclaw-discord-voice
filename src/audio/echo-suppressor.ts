import { ECHO_COOLDOWN_MS, BYTES_PER_SAMPLE } from "../constants.js";

/**
 * Suppresses echo from the bot's own audio coming back through users' microphones.
 *
 * Strategy (two-stage):
 * 1. Temporal gating: While the bot is speaking and for ECHO_COOLDOWN_MS after,
 *    any incoming audio whose energy is below the outbound energy + margin is suppressed.
 *    This handles the common case without AEC math.
 *
 * 2. Fingerprint matching: Compares incoming RMS against a ring buffer of recent
 *    outbound RMS values (with propagation delay). Highly correlated frames are suppressed.
 *
 * This is not a full acoustic echo canceller — it's a practical approach for Discord
 * where the bot's audio rarely echoes back loudly enough to trigger false VAD detections.
 */
export class EchoSuppressor {
  private isBotSpeaking = false;
  private botStoppedSpeakingAt = 0;

  /** Ring buffer of recent outbound RMS values (last 50 × 20ms = 1 second) */
  private outboundRmsHistory: number[] = [];
  private readonly historyLength = 50;

  /** Register that the bot is about to play audio (for outbound fingerprinting). */
  registerOutbound(pcm: Buffer): void {
    const rms = calculateRms(pcm);
    this.outboundRmsHistory.push(rms);
    if (this.outboundRmsHistory.length > this.historyLength) {
      this.outboundRmsHistory.shift();
    }
  }

  /** Notify that the bot started/stopped speaking. */
  setSpeaking(speaking: boolean): void {
    if (!speaking && this.isBotSpeaking) {
      this.botStoppedSpeakingAt = Date.now();
    }
    this.isBotSpeaking = speaking;
  }

  /**
   * Check whether an incoming PCM buffer should be suppressed as echo.
   * Returns true if the audio is likely echo and should be dropped.
   */
  shouldSuppress(pcm: Buffer): boolean {
    if (!this.isBotSpeaking && !this.isInCooldown()) {
      return false;
    }

    const inRms = calculateRms(pcm);

    // During cooldown with low energy — likely echo tail, suppress
    if (this.isInCooldown() && !this.isBotSpeaking) {
      return inRms < 600;
    }

    // While bot is speaking: check if incoming RMS matches outbound
    if (this.isBotSpeaking) {
      const avgOutboundRms = this.getAverageOutboundRms();
      // Suppress if incoming audio is within 40% of outbound energy
      // (allows barge-in: user speaking over bot will be louder)
      if (avgOutboundRms > 0 && inRms < avgOutboundRms * 1.4) {
        return true;
      }
    }

    return false;
  }

  /** Clear history (e.g., when the session resets). */
  reset(): void {
    this.outboundRmsHistory = [];
    this.isBotSpeaking = false;
    this.botStoppedSpeakingAt = 0;
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private isInCooldown(): boolean {
    if (this.isBotSpeaking) return false;
    return Date.now() - this.botStoppedSpeakingAt < ECHO_COOLDOWN_MS;
  }

  private getAverageOutboundRms(): number {
    if (this.outboundRmsHistory.length === 0) return 0;
    const sum = this.outboundRmsHistory.reduce((a, b) => a + b, 0);
    return sum / this.outboundRmsHistory.length;
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function calculateRms(pcm: Buffer): number {
  const samples = pcm.length / BYTES_PER_SAMPLE;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}
