import type { ConversationTurn, ToolDefinition } from "./types.js";

// ── OpenClaw API types (from api.runtime.channel.reply) ─────────────────────

/** Inbound message context — describes the user message being dispatched. */
interface MsgContext {
  Body?: string;
  BodyForAgent?: string;
  From?: string;
  To?: string;
  SessionKey?: string;
  Surface?: string;
  Provider?: string;
  SenderName?: string;
  SenderId?: string;
  ChatType?: string;
  Timestamp?: number;
  MessageSid?: string;
  InboundHistory?: Array<{ sender: string; body: string; timestamp?: number }>;
}

/** Payload delivered by the dispatcher when the agent produces a reply. */
interface ReplyPayload {
  text?: string;
  mediaUrl?: string;
  [key: string]: unknown;
}

type ReplyDispatchKind = "tool" | "block" | "final";

interface ReplyDispatcherWithTypingOptions {
  deliver: (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => Promise<void>;
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => void;
  onCleanup?: () => void;
  onError?: (err: unknown, info: { kind: ReplyDispatchKind }) => void;
  onSkip?: (payload: ReplyPayload, info: { kind: ReplyDispatchKind; reason: string }) => void;
}

interface DispatchInboundResult {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
}

/** The subset of api.runtime we actually use. */
interface ChannelReplyRuntime {
  dispatchReplyWithBufferedBlockDispatcher: (params: {
    ctx: MsgContext;
    cfg: unknown;
    dispatcherOptions: ReplyDispatcherWithTypingOptions;
  }) => Promise<DispatchInboundResult>;
  finalizeInboundContext?: (ctx: MsgContext) => MsgContext;
}

/** The real OpenClaw plugin API surface used by CoreBridge. */
interface OpenClawApi {
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
  config: unknown;
  runtime: {
    channel: {
      reply: ChannelReplyRuntime;
    };
  };
}

interface RegisteredTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Bridges between voice engines and the OpenClaw agent system.
 *
 * Pipeline mode:
 *   - Dispatches transcribed speech to the OpenClaw agent via the channel reply API
 *   - Agent replies flow back through a deliver callback → TTS pipeline
 *
 * S2S mode:
 *   - Local tool registry for S2S providers to call
 */
export class CoreBridge {
  private logger: OpenClawApi["logger"];
  private replyRuntime: ChannelReplyRuntime;
  private cfg: unknown;
  private toolRegistry = new Map<string, RegisteredTool>();

  constructor(api: OpenClawApi) {
    this.logger = api.logger;
    this.replyRuntime = api.runtime.channel.reply;
    this.cfg = api.config;
  }

  // ── Pipeline mode ─────────────────────────────────────────────────────────────

  /**
   * Dispatch transcribed speech to the OpenClaw agent and stream the response.
   *
   * Builds a MsgContext from the user's utterance, dispatches it through the
   * OpenClaw agent pipeline, and calls onChunk with each response chunk as
   * it arrives. Returns the full concatenated response.
   */
  async streamAgentResponse(
    userId: string,
    text: string,
    history: readonly ConversationTurn[],
    onChunk: (text: string) => void
  ): Promise<string> {
    const chunks: string[] = [];

    const ctx = this.buildMsgContext(userId, text, history);

    try {
      await this.replyRuntime.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: this.cfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            if (payload.text) {
              chunks.push(payload.text);
              onChunk(payload.text);
            }
          },
          onError: (err, { kind }) => {
            this.logger.error(`[core-bridge] Agent dispatch error (${kind})`, err);
          },
        },
      });
    } catch (err) {
      this.logger.error("[core-bridge] Agent dispatch failed", err);
      const errMsg = "[Error generating response]";
      onChunk(errMsg);
      return errMsg;
    }

    const fullResponse = chunks.join("");
    if (!fullResponse) {
      const fallback = "[No response from agent]";
      onChunk(fallback);
      return fallback;
    }

    return fullResponse;
  }

  // ── S2S tool registry ─────────────────────────────────────────────────────────

  /** Register a tool for S2S providers to call. */
  registerTool(
    definition: ToolDefinition,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ): void {
    this.toolRegistry.set(definition.name, { definition, execute: handler });
    this.logger.info(`[core-bridge] Registered tool: ${definition.name}`);
  }

  /** Get all registered tool definitions for S2S provider session setup. */
  getAvailableTools(): ToolDefinition[] {
    return Array.from(this.toolRegistry.values()).map(e => e.definition);
  }

  /** Execute a tool call from a speech-to-speech provider. */
  async executeToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.toolRegistry.get(name);
    if (!entry) {
      this.logger.warn(`[core-bridge] Tool not found: ${name}`);
      return { error: `Tool "${name}" is not registered` };
    }

    try {
      return await entry.execute(args);
    } catch (err) {
      this.logger.error(`[core-bridge] Tool execution failed: ${name}`, err);
      return { error: String(err) };
    }
  }

  // ── Session summary ────────────────────────────────────────────────────────────

  /**
   * Dispatch a voice session transcript to the OpenClaw agent on session end.
   * The agent receives the full conversation as context and replies with a
   * brief status acknowledgement, keeping the conversation in its memory.
   */
  async dispatchSessionSummary(
    engineMode: string,
    history: readonly ConversationTurn[]
  ): Promise<void> {
    if (history.length === 0) {
      this.logger.info("[core-bridge] No conversation to summarize");
      return;
    }

    const transcript = history
      .map(t => {
        const speaker = t.role === "user"
          ? (t.username ? `User (${t.username})` : "User")
          : "Assistant";
        return `${speaker}: ${t.content}`;
      })
      .join("\n");

    const summaryText =
      `[Voice session ended — ${engineMode} mode, ${history.length} turns]\n\n` +
      `Transcript:\n${transcript}\n\n` +
      `Please briefly acknowledge this voice conversation for your records.`;

    // Use the first user in the conversation as the sender, or "system"
    const firstUser = history.find(t => t.role === "user");
    const userId = firstUser?.userId ?? "system";

    const ctx: MsgContext = {
      Body: summaryText,
      BodyForAgent: summaryText,
      From: userId,
      SenderId: userId,
      SenderName: firstUser?.username ?? "discord-voice",
      Surface: "discord-voice",
      Provider: "discord-voice",
      ChatType: "direct",
      SessionKey: `voice:${userId}`,
      Timestamp: Date.now(),
      MessageSid: `voice-summary-${Date.now()}`,
    };

    try {
      await this.replyRuntime.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: this.cfg,
        dispatcherOptions: {
          deliver: async () => {
            // Discard the agent's response — we only want the side effect
            // of recording this conversation in the agent's memory
          },
          onError: (err) => {
            this.logger.error("[core-bridge] Session summary dispatch error", err);
          },
        },
      });
      this.logger.info(`[core-bridge] Session summary dispatched (${history.length} turns)`);
    } catch (err) {
      this.logger.error("[core-bridge] Failed to dispatch session summary", err);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private buildMsgContext(
    userId: string,
    text: string,
    history: readonly ConversationTurn[]
  ): MsgContext {
    // Build inbound history from conversation turns
    const inboundHistory = history.map(turn => ({
      sender: turn.role === "user" ? (turn.userId ?? userId) : "assistant",
      body: turn.content,
      timestamp: turn.timestamp,
    }));

    return {
      Body: text,
      BodyForAgent: text,
      From: userId,
      SenderId: userId,
      SenderName: history.find(t => t.role === "user" && t.username)?.username ?? userId,
      Surface: "discord-voice",
      Provider: "discord-voice",
      ChatType: "direct",
      SessionKey: `voice:${userId}`,
      Timestamp: Date.now(),
      MessageSid: `voice-${userId}-${Date.now()}`,
      InboundHistory: inboundHistory,
    };
  }
}
