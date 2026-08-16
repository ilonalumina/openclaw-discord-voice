import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { S2sProvider, S2sSession, S2sSessionOptions, ToolDefinition, ToolCall } from "../../types.js";
import type { ResolvedGeminiLiveConfig } from "../../types.js";
import { GEMINI_SESSION_ROTATION_BUFFER_MS } from "../../constants.js";

const GEMINI_BASE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.BidiGenerateContent";

/**
 * Google Gemini Live API provider (native speech-to-speech).
 * Uses BidiGenerateContent WebSocket protocol for bidirectional audio streaming.
 *
 * Handles:
 * - 10-minute session limit with transparent reconnection
 * - Audio at 16kHz PCM16 input, output format varies
 * - Function calling support
 */
export class GeminiLiveProvider implements S2sProvider {
  readonly id = "gemini-live";
  private config: ResolvedGeminiLiveConfig;

  constructor(config: ResolvedGeminiLiveConfig) {
    this.config = config;
  }

  async connect(options: S2sSessionOptions): Promise<S2sSession> {
    const session = new GeminiLiveSession(this.config, options);
    await session.connect();
    return session;
  }
}

// ── Session ───────────────────────────────────────────────────────────────────

class GeminiLiveSession extends EventEmitter implements S2sSession {
  private ws: WebSocket | null = null;
  private config: ResolvedGeminiLiveConfig;
  private options: S2sSessionOptions;
  private rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private isRotating = false;
  private pendingFunctionCalls = new Map<string, ToolCall>();

  constructor(config: ResolvedGeminiLiveConfig, options: S2sSessionOptions) {
    super();
    this.config = config;
    this.options = options;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_BASE_URL}?key=${encodeURIComponent(this.config.apiKey)}`;

      this.ws = new WebSocket(url);

      this.ws.once("open", () => {
        this.sendSetup();
        this.scheduleRotation();
        resolve();
      });

      this.ws.once("error", (err) => reject(err));
      this.ws.on("message", (data) => this.handleMessage(data));
      this.ws.on("close", () => {
        if (!this.isRotating) {
          this.emit("error", new Error("Gemini Live connection closed unexpectedly"));
        }
      });
    });
  }

  sendAudio(pcm: Buffer): void {
    // Gemini expects 16kHz PCM16 audio
    this.sendMessage({
      realtimeInput: {
        mediaChunks: [{
          mimeType: "audio/pcm;rate=16000",
          data: pcm.toString("base64"),
        }],
      },
    });
  }

  sendText(text: string): void {
    this.sendMessage({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  commitAudio(): void {
    this.sendMessage({
      realtimeInput: { activityEnd: {} },
    });
  }

  cancelResponse(): void {
    // Gemini doesn't have a direct cancel — send an interruption signal
    this.sendMessage({ clientContent: { turnComplete: false } });
  }

  updateTools(tools: ToolDefinition[]): void {
    // Tool updates require a new session in Gemini — skip mid-session updates
    // Tools should be registered in the initial setup
    void tools;
  }

  sendToolResult(callId: string, result: unknown): void {
    this.sendMessage({
      toolResponse: {
        functionResponses: [{
          id: callId,
          name: this.pendingFunctionCalls.get(callId)?.name ?? "unknown",
          response: { output: result },
        }],
      },
    });
    this.pendingFunctionCalls.delete(callId);
  }

  async close(): Promise<void> {
    this.clearRotationTimer();
    this.ws?.close();
    this.ws = null;
    this.removeAllListeners();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private handleMessage(data: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    // Server content (audio + text)
    const serverContent = msg["serverContent"] as Record<string, unknown> | undefined;
    if (serverContent) {
      const modelTurn = serverContent["modelTurn"] as Record<string, unknown> | undefined;
      if (modelTurn) {
        const parts = modelTurn["parts"] as Array<Record<string, unknown>> | undefined;
        for (const part of parts ?? []) {
          if (part["inlineData"]) {
            const inlineData = part["inlineData"] as Record<string, string>;
            const audioData = Buffer.from(inlineData["data"] ?? "", "base64");
            // Gemini outputs at 24kHz by default
            this.emit("audio", audioData, 24_000);
          }
          if (part["text"]) {
            this.emit("transcript-out", part["text"] as string);
          }
        }
      }

      if (serverContent["turnComplete"]) {
        this.emit("turn-end");
      }

      if (serverContent["interrupted"]) {
        this.emit("interrupted");
      }
    }

    // Tool calls
    const toolCall = msg["toolCall"] as Record<string, unknown> | undefined;
    if (toolCall) {
      const calls = toolCall["functionCalls"] as Array<Record<string, unknown>> | undefined;
      for (const call of calls ?? []) {
        const tc: ToolCall = {
          callId: call["id"] as string,
          name: call["name"] as string,
          args: (call["args"] as Record<string, unknown>) ?? {},
        };
        this.pendingFunctionCalls.set(tc.callId, tc);
        this.emit("tool-call", tc);
      }
    }

    // Input transcription
    const inputTranscription = msg["inputTranscription"] as Record<string, unknown> | undefined;
    if (inputTranscription?.["text"]) {
      this.emit("transcript-in", inputTranscription["text"] as string);
    }
  }

  private sendSetup(): void {
    const tools = (this.options.tools ?? []).map(t => ({
      functionDeclarations: [{
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }],
    }));

    this.sendMessage({
      setup: {
        model: `models/${this.config.model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: this.config.voice },
            },
          },
        },
        systemInstruction: this.buildSystemInstruction(),
        tools: tools.length > 0 ? tools : undefined,
      },
    });
  }

  private sendMessage(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private scheduleRotation(): void {
    const rotateAfterMs = this.config.sessionDurationMs - GEMINI_SESSION_ROTATION_BUFFER_MS;
    this.rotationTimer = setTimeout(() => void this.rotateSession(), Math.max(rotateAfterMs, 0));
  }

  private clearRotationTimer(): void {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  private async rotateSession(): Promise<void> {
    this.isRotating = true;
    this.clearRotationTimer();

    const oldWs = this.ws;

    try {
      // Open new connection before closing old one
      await this.connect();
    } catch (err) {
      this.emit("error", new Error(`Gemini session rotation failed: ${String(err)}`));
      this.isRotating = false;
      return;
    }

    // Close old connection after new one is ready
    oldWs?.close();
    this.isRotating = false;
  }

  private buildSystemInstruction(): string {
    const base = this.config.instructions ?? "You are a helpful voice assistant.";
    if (!this.options.conversationHistory?.length) return base;

    const history = this.options.conversationHistory
      .slice(-10) // Limit history for session init
      .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
      .join("\n");

    return `${base}\n\nRecent conversation:\n${history}`;
  }
}
