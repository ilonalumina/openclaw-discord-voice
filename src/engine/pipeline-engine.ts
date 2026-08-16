import { EventEmitter } from "node:events";
import type { VoiceEngine } from "./engine-interface.js";
import type { ConversationTurn, VoiceSessionContext, SttProvider, TtsProvider, TtsStream } from "../types.js";
import { createSttProvider } from "../providers/stt/stt-interface.js";
import { createTtsProvider } from "../providers/tts/tts-interface.js";
import { ConversationContext } from "../session/conversation-context.js";
import type { CoreBridge } from "../core-bridge.js";
import { TTS_MAX_CHARS, PROCESSING_SAMPLE_RATE } from "../constants.js";

/**
 * Pipeline engine: STT → OpenClaw agent (LLM) → TTS
 *
 * Buffer-then-speak: the full LLM reply is collected first, then synthesized
 * as ONE TTS request. Sentence-level pipelining has two failure modes: when
 * the LLM and a local TTS share the same GPU, running both generators
 * concurrently starves the TTS; and per-sentence requests give every sentence
 * its own prosodic arc with no inter-sentence pause, so replies sound
 * stitched together. A single request lets the model plan intonation and
 * pauses across the whole reply; with a streaming-capable server
 * (tts.openai.streamPcm) audio chunks still arrive as they are generated, and
 * a short pre-buffer absorbs generation jitter near 1x realtime.
 *
 *   User speech → [STT] → transcript
 *                             │
 *                    [OpenClaw Agent / LLM]  (runs alone first)
 *                             │
 *                  full reply → [TTS, one stream] → pre-buffer → audio-out
 */
export class PipelineEngine extends EventEmitter implements VoiceEngine {
  readonly mode = "pipeline" as const;

  private stt: SttProvider | null = null;
  private tts: TtsProvider | null = null;
  private fallbackStt: SttProvider | null = null;
  private fallbackTts: TtsProvider | null = null;
  private coreBridge: CoreBridge;
  private conversation: ConversationContext;

  // Per-user audio accumulation (for batch STT fallback)
  private userAudioBuffers = new Map<string, Buffer[]>();

  // Processing lock — only one user at a time for natural conversation
  private isProcessing = false;
  private interrupted = false;

  // Active TTS stream so barge-in can cancel mid-reply (one stream per turn now)
  private activeTtsStream: TtsStream | null = null;

  constructor(coreBridge: CoreBridge, maxConversationTurns = 50) {
    super();
    this.coreBridge = coreBridge;
    this.conversation = new ConversationContext({ maxTurns: maxConversationTurns });
  }

  async start(session: VoiceSessionContext): Promise<void> {
    const { config } = session;

    // Initialize primary providers
    this.stt = await createSttProvider(config.stt.provider, config.stt);
    this.tts = await createTtsProvider(config.tts.provider, config.tts);

    // Initialize fallback providers (lazy — only if primary fails)
    if (config.stt.fallback !== config.stt.provider) {
      this.fallbackStt = await createSttProvider(config.stt.fallback, config.stt).catch(() => null);
    }
    if (config.tts.fallback !== config.tts.provider) {
      this.fallbackTts = await createTtsProvider(config.tts.fallback, config.tts).catch(() => null);
    }
  }

  feedAudio(userId: string, pcm: Buffer, _sampleRate: number): void {
    // If using streaming STT, forward audio directly
    // (streaming STT handles its own buffering)
    // If using batch STT, accumulate until endOfSpeech
    if (!this.userAudioBuffers.has(userId)) {
      this.userAudioBuffers.set(userId, []);
    }
    this.userAudioBuffers.get(userId)!.push(pcm);
  }

  endOfSpeech(userId: string): void {
    if (this.isProcessing) return;

    const buffers = this.userAudioBuffers.get(userId);
    this.userAudioBuffers.delete(userId);

    if (!buffers || buffers.length === 0) return;

    const audio = Buffer.concat(buffers);
    this.processUtterance(userId, audio).catch((err) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  async injectText(userId: string, text: string): Promise<void> {
    await this.generateAndSpeak(userId, text);
  }

  interrupt(): void {
    this.interrupted = true;
    // Cancel the in-flight TTS stream (one stream per turn) so the server
    // stops generating; session handles stopping playback.
    this.activeTtsStream?.cancel();
    this.activeTtsStream = null;
  }

  getConversationHistory(): readonly ConversationTurn[] {
    return this.conversation.getHistory();
  }

  async stop(): Promise<void> {
    this.interrupted = true;
    await this.stt?.dispose();
    await this.tts?.dispose();
    await this.fallbackStt?.dispose();
    await this.fallbackTts?.dispose();
    this.userAudioBuffers.clear();
    this.removeAllListeners();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private async processUtterance(userId: string, audio: Buffer): Promise<void> {
    this.isProcessing = true;
    this.interrupted = false;

    try {
      // Step 1: STT — transcribe the audio
      const sttResult = await this.transcribeWithFallback(audio);
      if (!sttResult.text.trim()) return;

      this.emit("transcript-in", userId, sttResult.text);

      // Step 2: LLM — stream the agent's response with sentence-level TTS pipelining
      await this.generateAndSpeak(userId, sttResult.text);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isProcessing = false;
    }
  }

  private async generateAndSpeak(userId: string, userText: string): Promise<void> {
    const history = this.conversation.getHistory();

    // Add user turn to context
    this.conversation.addTurn({
      role: "user",
      userId,
      content: userText,
      timestamp: Date.now(),
    });

    const responseTokens: string[] = [];

    await this.coreBridge.streamAgentResponse(
      userId,
      userText,
      history,
      (token) => {
        if (this.interrupted) return;
        responseTokens.push(token);
      }
    );

    const fullResponse = responseTokens.join("");
    if (fullResponse) {
      this.emit("transcript-out", fullResponse);
      this.conversation.addTurn({
        role: "assistant",
        content: fullResponse,
        timestamp: Date.now(),
      });
    }

    // Buffer-then-speak: synthesize the WHOLE reply as one TTS request, only
    // after the LLM stream completes (see class doc). Replies longer than
    // TTS_MAX_CHARS (rare) are split at sentence boundaries.
    if (!this.interrupted) {
      for (const block of splitForTts(fullResponse)) {
        if (this.interrupted) break;
        await this.synthesizeAndEmit(block);
      }
    }

    this.emit("turn-end");
  }

  private synthesizeAndEmit(text: string): Promise<void> {
    if (!text.trim() || !this.tts) return Promise.resolve();

    const ttsStream = this.tts.synthesizeStream(text);
    this.activeTtsStream = ttsStream;

    // Pre-buffer ~5s of audio before emitting: a local TTS server generates
    // near 1x realtime, so playback margin accrues slowly — a mid-stream
    // stall (e.g. other load grabbing the same GPU) longer than the
    // accumulated margin starves playback. 24kHz mono s16 = 48,000 bytes/s.
    const PREBUFFER_BYTES = 5 * 48_000;
    let held: Buffer[] = [];
    let heldBytes = 0;
    let playing = false;

    return new Promise<void>((resolve) => {
      const flushHeld = () => {
        if (heldBytes > 0) {
          this.emit("audio-out", Buffer.concat(held), 24_000);
          held = [];
          heldBytes = 0;
        }
        playing = true;
      };

      ttsStream.on("audio", (chunk: Buffer, sampleRate: number) => {
        if (this.interrupted) return;
        if (playing) {
          this.emit("audio-out", chunk, sampleRate);
          return;
        }
        held.push(chunk);
        heldBytes += chunk.length;
        if (heldBytes >= PREBUFFER_BYTES) flushHeld();
      });

      ttsStream.on("end", () => {
        if (!this.interrupted && !playing) flushHeld(); // reply shorter than the pre-buffer
        this.activeTtsStream = null;
        resolve();
      });

      ttsStream.on("error", (err: Error) => {
        this.emit("error", err);
        this.activeTtsStream = null;
        resolve();
      });
    });
  }

  private async transcribeWithFallback(audio: Buffer): Promise<{ text: string }> {
    const sampleRate = PROCESSING_SAMPLE_RATE;

    try {
      if (this.stt?.transcribe) {
        return await this.stt.transcribe(audio, { sampleRate });
      }
      throw new Error("Primary STT has no batch transcription support");
    } catch (err) {
      if (this.fallbackStt?.transcribe) {
        return await this.fallbackStt.transcribe(audio, { sampleRate });
      }
      throw err;
    }
  }
}

// ── TTS block splitter ────────────────────────────────────────────────────────

/**
 * The whole reply goes to TTS as one request so the model plans prosody and
 * pauses across it. Only replies longer than TTS_MAX_CHARS (rare) are split,
 * at the sentence boundary nearest each limit.
 */
function splitForTts(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= TTS_MAX_CHARS) return [trimmed];

  const blocks: string[] = [];
  let rest = trimmed;
  while (rest.length > TTS_MAX_CHARS) {
    const slice = rest.slice(0, TTS_MAX_CHARS);
    const boundary = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? ")
    );
    const cut = boundary > 0 ? boundary + 1 : TTS_MAX_CHARS;
    blocks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) blocks.push(rest);
  return blocks;
}
