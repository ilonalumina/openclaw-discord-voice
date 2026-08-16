import { EventEmitter } from "node:events";
import type { VoiceEngine } from "./engine-interface.js";
import type { ConversationTurn, VoiceSessionContext, S2sProvider, S2sSession } from "../types.js";
import { createS2sProvider } from "../providers/s2s/s2s-interface.js";
import { ConversationContext } from "../session/conversation-context.js";
import type { CoreBridge } from "../core-bridge.js";

/**
 * Speech-to-speech engine: wraps OpenAI Realtime API or Gemini Live.
 *
 * Unlike the pipeline engine, this sends audio directly to the provider
 * which handles STT, reasoning, and TTS natively. This eliminates
 * the latency of three separate API calls.
 *
 * Function calls from the provider are bridged to OpenClaw's tool system.
 */
export class SpeechToSpeechEngine extends EventEmitter implements VoiceEngine {
  readonly mode = "speech-to-speech" as const;

  private provider: S2sProvider | null = null;
  private session: S2sSession | null = null;
  private conversation: ConversationContext;
  private coreBridge: CoreBridge;

  constructor(coreBridge: CoreBridge, maxConversationTurns = 50) {
    super();
    this.coreBridge = coreBridge;
    this.conversation = new ConversationContext({ maxTurns: maxConversationTurns });
  }

  async start(sessionContext: VoiceSessionContext): Promise<void> {
    const { config } = sessionContext;

    if (!config.s2s.provider) {
      throw new Error("S2S provider not configured");
    }

    this.provider = config.s2s.provider === "openai-realtime"
      ? await createS2sProvider("openai-realtime", config.s2s.openaiRealtime)
      : await createS2sProvider("gemini-live", config.s2s.geminiLive);

    const tools = this.coreBridge.getAvailableTools();

    this.session = await this.provider.connect({
      ...(config.behavior.systemPrompt !== undefined && { instructions: config.behavior.systemPrompt }),
      tools,
      conversationHistory: [...this.conversation.getHistory()],
    });

    this.attachSessionEvents();
  }

  feedAudio(userId: string, pcm: Buffer, sampleRate: number): void {
    // S2S providers expect 16kHz mono PCM for Gemini or 24kHz for OpenAI Realtime
    // The session handles internal format requirements
    void userId;
    void sampleRate;
    this.session?.sendAudio(pcm);
  }

  endOfSpeech(_userId: string): void {
    // Most S2S providers handle VAD natively via server_vad
    // For providers that need explicit commit, call commitAudio
    // OpenAI Realtime uses server_vad by default so this is a no-op
    // Gemini may need an activity end signal
    this.session?.commitAudio();
  }

  async injectText(_userId: string, text: string): Promise<void> {
    this.session?.sendText(text);
  }

  interrupt(): void {
    this.session?.cancelResponse();
  }

  getConversationHistory(): readonly ConversationTurn[] {
    return this.conversation.getHistory();
  }

  async stop(): Promise<void> {
    await this.session?.close();
    this.session = null;
    this.provider = null;
    this.removeAllListeners();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private attachSessionEvents(): void {
    if (!this.session) return;

    this.session.on("audio", (chunk: Buffer, sampleRate: number) => {
      this.emit("audio-out", chunk, sampleRate);
    });

    this.session.on("transcript-in", (text: string) => {
      this.emit("transcript-in", "unknown", text);
      this.conversation.addTurn({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
    });

    this.session.on("transcript-out", (text: string) => {
      this.emit("transcript-out", text);
      this.conversation.addTurn({
        role: "assistant",
        content: text,
        timestamp: Date.now(),
      });
    });

    this.session.on("tool-call", async (call) => {
      try {
        const result = await this.coreBridge.executeToolCall(call.name, call.args);
        this.session?.sendToolResult(call.callId, result);
      } catch (err) {
        this.session?.sendToolResult(call.callId, { error: String(err) });
      }
    });

    this.session.on("interrupted", () => {
      this.emit("transcript-out", "");
    });

    this.session.on("turn-end", () => {
      // Turn complete — session state managed by provider
    });

    this.session.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }
}
