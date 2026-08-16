import type { S2sProvider, S2sSession, S2sSessionOptions, ToolDefinition, ToolCall, ResolvedOpenAiRealtimeConfig, ResolvedGeminiLiveConfig } from "../../types.js";

export type { S2sProvider, S2sSession, S2sSessionOptions, ToolDefinition, ToolCall };

/**
 * Create an S2S provider by name.
 */
export async function createS2sProvider(name: "openai-realtime", config: ResolvedOpenAiRealtimeConfig): Promise<S2sProvider>;
export async function createS2sProvider(name: "gemini-live", config: ResolvedGeminiLiveConfig): Promise<S2sProvider>;
export async function createS2sProvider(
  name: "openai-realtime" | "gemini-live",
  config: ResolvedOpenAiRealtimeConfig | ResolvedGeminiLiveConfig
): Promise<S2sProvider> {
  switch (name) {
    case "openai-realtime": {
      const { OpenAiRealtimeProvider } = await import("./openai-realtime.js");
      return new OpenAiRealtimeProvider(config as ResolvedOpenAiRealtimeConfig);
    }
    case "gemini-live": {
      const { GeminiLiveProvider } = await import("./gemini-live.js");
      return new GeminiLiveProvider(config as ResolvedGeminiLiveConfig);
    }
  }
}
