import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { S2sProvider, S2sSession, S2sSessionOptions, ToolDefinition, ToolCall } from "../../types.js";
import type { ResolvedOpenAiRealtimeConfig } from "../../types.js";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";

/**
 * OpenAI Realtime API provider (native speech-to-speech).
 * Connects to the Realtime WebSocket API for lowest possible latency
 * by eliminating the separate STT → LLM → TTS pipeline.
 *
 * Handles:
 * - Server-side VAD (no separate VAD needed)
 * - Native interruptions
 * - Function calling bridged to OpenClaw tools
 * - Audio delta streaming at 24kHz PCM
 */
export class OpenAiRealtimeProvider implements S2sProvider {
  readonly id = "openai-realtime";
  private config: ResolvedOpenAiRealtimeConfig;

  constructor(config: ResolvedOpenAiRealtimeConfig) {
    this.config = config;
  }

  async connect(options: S2sSessionOptions): Promise<S2sSession> {
    const session = new OpenAiRealtimeSession(this.config, options);
    await session.connect();
    return session;
  }
}

// ── Session ───────────────────────────────────────────────────────────────────

class OpenAiRealtimeSession extends EventEmitter implements S2sSession {
  private ws: WebSocket | null = null;
  private config: ResolvedOpenAiRealtimeConfig;
  private options: S2sSessionOptions;
  private currentResponseId: string | null = null;

  constructor(config: ResolvedOpenAiRealtimeConfig, options: S2sSessionOptions) {
    super();
    this.config = config;
    this.options = options;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${REALTIME_URL}?model=${encodeURIComponent(this.config.model)}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.once("open", () => {
        this.sendEvent({ type: "session.update", session: this.buildSessionConfig() });
        resolve();
      });

      this.ws.once("error", (err) => reject(err));
      this.ws.on("message", (data) => this.handleMessage(data));
      this.ws.on("close", () => this.emit("error", new Error("OpenAI Realtime connection closed")));
    });
  }

  sendAudio(pcm: Buffer): void {
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    });
  }

  sendText(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.sendEvent({ type: "response.create" });
  }

  commitAudio(): void {
    this.sendEvent({ type: "input_audio_buffer.commit" });
    this.sendEvent({ type: "response.create" });
  }

  cancelResponse(): void {
    if (this.currentResponseId) {
      this.sendEvent({ type: "response.cancel" });
    }
  }

  updateTools(tools: ToolDefinition[]): void {
    this.sendEvent({
      type: "session.update",
      session: {
        tools: tools.map(t => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    });
  }

  sendToolResult(callId: string, result: unknown): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this.removeAllListeners();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private handleMessage(data: WebSocket.RawData): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = event["type"] as string;

    switch (type) {
      case "response.audio.delta": {
        const delta = event["delta"] as string;
        if (delta) {
          this.emit("audio", Buffer.from(delta, "base64"), 24_000);
        }
        break;
      }
      case "response.audio_transcript.delta": {
        const delta = event["delta"] as string;
        if (delta) this.emit("transcript-out", delta);
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = event["transcript"] as string;
        if (transcript) this.emit("transcript-in", transcript);
        break;
      }
      case "response.function_call_arguments.done": {
        const call: ToolCall = {
          callId: event["call_id"] as string,
          name: event["name"] as string,
          args: JSON.parse(event["arguments"] as string) as Record<string, unknown>,
        };
        this.emit("tool-call", call);
        break;
      }
      case "response.created": {
        this.currentResponseId = (event["response"] as Record<string, unknown>)?.["id"] as string;
        break;
      }
      case "response.done": {
        this.currentResponseId = null;
        this.emit("turn-end");
        break;
      }
      case "input_audio_buffer.speech_stopped": {
        // Server VAD detected end of speech
        break;
      }
      case "error": {
        const errMsg = (event["error"] as Record<string, unknown>)?.["message"] as string ?? "Unknown error";
        this.emit("error", new Error(`OpenAI Realtime: ${errMsg.slice(0, 200)}`));
        break;
      }
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private buildSessionConfig(): Record<string, unknown> {
    return {
      modalities: ["text", "audio"],
      voice: this.config.voice,
      instructions: this.buildInstructions(),
      temperature: this.config.temperature,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: { type: "server_vad", silence_duration_ms: 800 },
      tools: (this.options.tools ?? []).map(t => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    };
  }

  private buildInstructions(): string {
    const base = this.config.instructions ?? "You are a helpful voice assistant.";
    if (!this.options.conversationHistory?.length) return base;

    const history = this.options.conversationHistory
      .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
      .join("\n");

    return `${base}\n\nConversation so far:\n${history}`;
  }
}
