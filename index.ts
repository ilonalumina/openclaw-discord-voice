/**
 * openclaw-discord-voice
 *
 * Real-time voice conversations in Discord voice channels.
 * Supports dual-mode operation:
 *   - "speech-to-speech": OpenAI Realtime API or Gemini Live (lowest latency)
 *   - "pipeline": Deepgram STT → OpenClaw agent → Cartesia TTS (maximum provider choice)
 *
 * Auto mode (default) prefers speech-to-speech when credentials are available.
 */

import type { ResolvedConfig } from "./src/types.js";
import { resolveConfig } from "./src/config.js";
import type { RawConfig } from "./src/config.js";
import { SessionManager } from "./src/session/session-manager.js";
import { CoreBridge } from "./src/core-bridge.js";

// ── Shared runtime state ───────────────────────────────────────────────────────
// OpenClaw instantiates this plugin in separate contexts for its "channel" and
// "tool" capabilities. The long-running voice service starts in the channel
// context (populating sessionManager), but the agent's discord_voice tool call is
// dispatched in the tool context. A register()-local closure is NOT shared between
// them, so the tool handler would always see a null sessionManager ("Voice gateway
// is not running"). The gateway runs as a single node process, so these are hoisted
// to module scope — one require()d module, one shared set of references — letting
// the tool context read the state the service context created.
let config: ResolvedConfig | null = null;
let sessionManager: SessionManager | null = null;
let coreBridge: CoreBridge | null = null;

// ── Plugin definition ─────────────────────────────────────────────────────────

const plugin = {
  id: "discord-voice",
  name: "Discord Voice",
  description:
    "Real-time voice conversations in Discord voice channels with dual-mode engine",

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any) {
    const logger = api.logger as {
      info: (msg: string, ...args: unknown[]) => void;
      warn: (msg: string, ...args: unknown[]) => void;
      error: (msg: string, ...args: unknown[]) => void;
    };

    // config / sessionManager / coreBridge are module-scoped (see top of file) so
    // the tool-context instance can see state created by the channel-context service.

    // ── Service lifecycle ──────────────────────────────────────────────────────

    api.registerService({
      id: "discord-voice",

      async start() {
        try {
          // OpenClaw delivers plugin config as api.pluginConfig (api.config was the
          // upstream assumption and is empty on 2026.5.x). Fall back for compatibility.
          config = resolveConfig((api.pluginConfig ?? api.config) as RawConfig);
          logger.info(`[discord-voice] Starting in mode: ${config.mode}`);

          coreBridge = new CoreBridge(api);

          registerToolsOnBridge(coreBridge);

          sessionManager = new SessionManager(config, coreBridge, logger);

          logger.info("[discord-voice] Service started");
        } catch (err) {
          logger.error("[discord-voice] Failed to start", err);
          throw err;
        }
      },

      async stop() {
        logger.info("[discord-voice] Stopping service...");

        if (sessionManager) {
          await sessionManager.stopAll();
          sessionManager = null;
        }
        coreBridge = null;
        config = null;

        logger.info("[discord-voice] Service stopped");
      },
    });

    // ── Gateway RPC methods ────────────────────────────────────────────────────

    api.registerGatewayMethod(
      "discord-voice.join",
      async ({ respond, params }: { respond: GatewayRespond; params: JoinParams }) => {
        const { guildId, channelId } = params;

        if (!guildId || !channelId) {
          respond(false, { error: "guildId and channelId are required" });
          return;
        }

        ensureRunning();

        try {
          const session = await sessionManager!.join(guildId, channelId);
          respond(true, { guildId, channelId, mode: session.engine.mode });
        } catch (err) {
          respond(false, { error: String(err) });
        }
      }
    );

    api.registerGatewayMethod(
      "discord-voice.leave",
      async ({ respond, params }: { respond: GatewayRespond; params: LeaveParams }) => {
        const { guildId } = params;
        if (!guildId) { respond(false, { error: "guildId is required" }); return; }

        ensureRunning();

        try {
          await sessionManager!.leave(guildId);
          respond(true, { guildId });
        } catch (err) {
          respond(false, { error: String(err) });
        }
      }
    );

    api.registerGatewayMethod(
      "discord-voice.speak",
      async ({ respond, params }: { respond: GatewayRespond; params: SpeakParams }) => {
        const { guildId, text } = params;
        if (!guildId || !text) {
          respond(false, { error: "guildId and text are required" });
          return;
        }

        ensureRunning();

        try {
          const session = sessionManager!.getSession(guildId);
          if (!session) {
            respond(false, { error: `No active session in guild ${guildId}` });
            return;
          }
          await session.injectText(text);
          respond(true, { guildId, spoken: text });
        } catch (err) {
          respond(false, { error: String(err) });
        }
      }
    );

    api.registerGatewayMethod(
      "discord-voice.status",
      async ({ respond, params }: { respond: GatewayRespond; params: StatusParams }) => {
        const { guildId } = params;

        const session = guildId ? sessionManager?.getSession(guildId) : null;
        respond(true, {
          running: config !== null,
          mode: config?.mode,
          guildId: guildId ?? null,
          activeGuilds: sessionManager?.getActiveGuilds() ?? [],
          active: !!session,
          state: session?.state ?? null,
          engineMode: session?.engine.mode ?? null,
        });
      }
    );

    // ── Agent tool ─────────────────────────────────────────────────────────────

    const DISCORD_VOICE_SCHEMA = {
      type: "object",
      required: ["action", "guildId"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["join", "leave", "speak", "status"],
          description: "Action to perform",
        },
        guildId: {
          type: "string",
          description: "Discord guild (server) ID",
        },
        channelId: {
          type: "string",
          description: "Voice channel ID — required for join",
        },
        text: {
          type: "string",
          description: "Text to speak — required for speak action",
        },
      },
    } as const;

    async function handleDiscordVoiceTool(input: Record<string, unknown>) {
      const { action, guildId, channelId, text } = input as {
        action: string;
        guildId: string;
        channelId?: string;
        text?: string;
      };

      if (!sessionManager) {
        return { content: [{ type: "text", text: "Voice gateway is not running" }] };
      }

      switch (action) {
        case "join": {
          if (!channelId) {
            return { content: [{ type: "text", text: "channelId is required for join" }] };
          }
          const session = await sessionManager.join(guildId, channelId);
          return {
            content: [{
              type: "text",
              text: `Joined voice channel ${channelId} in guild ${guildId} (mode: ${session.engine.mode})`,
            }],
          };
        }

        case "leave":
          await sessionManager.leave(guildId);
          return { content: [{ type: "text", text: `Left voice channel in guild ${guildId}` }] };

        case "speak": {
          if (!text) {
            return { content: [{ type: "text", text: "text is required for speak" }] };
          }
          const s = sessionManager.getSession(guildId);
          if (!s) {
            return { content: [{ type: "text", text: `Not in a voice channel in guild ${guildId}` }] };
          }
          await s.injectText(text);
          return { content: [{ type: "text", text: `Speaking: "${text}"` }] };
        }

        case "status": {
          const s = sessionManager.getSession(guildId);
          const activeGuilds = sessionManager.getActiveGuilds();
          return {
            content: [{
              type: "text",
              text: s
                ? `Active in guild ${guildId}: state=${s.state}, engine=${s.engine.mode}`
                : `Not active in guild ${guildId}. Active guilds: ${activeGuilds.join(", ") || "none"}`,
            }],
          };
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
      }
    }

    // Register for OpenClaw agent access
    api.registerTool({
      name: "discord_voice",
      description:
        "Manage Discord voice channel connections. " +
        "Join or leave a voice channel, inject text to be spoken, or check status.",
      // OpenClaw's plugin tool contract requires the JSON schema under `parameters`
      // (not `inputSchema`); otherwise the loader rejects it as malformed.
      parameters: DISCORD_VOICE_SCHEMA,
      // OpenClaw invokes an agent tool as execute(id, params) — the call arguments
      // are the SECOND parameter. (The S2S CoreBridge path calls the handler with
      // the args object directly, so it keeps using handleDiscordVoiceTool as-is.)
      execute: (_id: string, params: Record<string, unknown>) =>
        handleDiscordVoiceTool(params ?? {}),
    });

    // Register on CoreBridge for S2S provider access
    function registerToolsOnBridge(bridge: CoreBridge) {
      bridge.registerTool(
        {
          name: "discord_voice",
          description:
            "Manage Discord voice channel connections. " +
            "Join or leave a voice channel, inject text to be spoken, or check status.",
          parameters: DISCORD_VOICE_SCHEMA,
        },
        handleDiscordVoiceTool
      );
    }

    // ── CLI commands ───────────────────────────────────────────────────────────

    api.registerCli(({ program }: { program: { command: (name: string) => CLICommand } }) => {
      const voice = program.command("voice")
        .description("Discord voice channel management");

      voice
        .command("join")
        .argument("<guildId>", "Discord guild ID")
        .argument("<channelId>", "Voice channel ID")
        .description("Join a Discord voice channel")
        .action(async (...args: unknown[]) => {
          const [guildId, channelId] = args as [string, string];
          if (!sessionManager) { console.error("Voice gateway is not running"); return; }
          try {
            const session = await sessionManager.join(guildId, channelId);
            console.log(`Joined channel ${channelId} in guild ${guildId} (mode: ${session.engine.mode})`);
          } catch (err) {
            console.error("Failed to join:", err);
          }
        });

      voice
        .command("leave")
        .argument("<guildId>", "Discord guild ID")
        .description("Leave the current voice channel")
        .action(async (...args: unknown[]) => {
          const [guildId] = args as [string];
          if (!sessionManager) { console.error("Voice gateway is not running"); return; }
          try {
            await sessionManager.leave(guildId);
            console.log(`Left voice channel in guild ${guildId}`);
          } catch (err) {
            console.error("Failed to leave:", err);
          }
        });

      voice
        .command("speak")
        .argument("<guildId>", "Discord guild ID")
        .argument("<text>", "Text to speak")
        .description("Speak text in the voice channel")
        .action(async (...args: unknown[]) => {
          const [guildId, text] = args as [string, string];
          if (!sessionManager) { console.error("Voice gateway is not running"); return; }
          const session = sessionManager.getSession(guildId);
          if (!session) { console.error(`Not in a voice channel in guild ${guildId}`); return; }
          try {
            await session.injectText(text);
            console.log(`Speaking: "${text}"`);
          } catch (err) {
            console.error("Failed to speak:", err);
          }
        });

      voice
        .command("status")
        .argument("[guildId]", "Discord guild ID (optional)")
        .description("Show voice channel status")
        .action(async (...args: unknown[]) => {
          const [guildId] = args as [string | undefined];
          if (!sessionManager) { console.log("Voice gateway is not running"); return; }

          const activeGuilds = sessionManager.getActiveGuilds();
          if (guildId) {
            const session = sessionManager.getSession(guildId);
            if (session) {
              console.log(`Guild ${guildId}: state=${session.state}, engine=${session.engine.mode}`);
            } else {
              console.log(`Not active in guild ${guildId}`);
            }
          } else {
            console.log(`Active guilds (${activeGuilds.length}): ${activeGuilds.join(", ") || "none"}`);
          }
        });
    }, { commands: ["voice"] });

    // ── Helpers ────────────────────────────────────────────────────────────────

    function ensureRunning(): void {
      if (!config || !sessionManager) {
        throw new Error("[discord-voice] Service is not running");
      }
    }
  },
};

export default plugin;

// ── Local types for untyped OpenClaw API ──────────────────────────────────────

type GatewayRespond = (success: boolean, data: Record<string, unknown>) => void;
interface JoinParams { guildId: string; channelId: string }
interface LeaveParams { guildId: string }
interface SpeakParams { guildId: string; text: string }
interface StatusParams { guildId?: string }
interface CLICommand {
  command: (name: string) => CLICommand;
  argument: (name: string, desc?: string) => CLICommand;
  description: (desc: string) => CLICommand;
  action: (fn: (...args: unknown[]) => unknown) => CLICommand;
}
