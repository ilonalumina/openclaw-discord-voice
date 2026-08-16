import type {
  ResolvedConfig,
  ResolvedSttConfig,
  ResolvedTtsConfig,
  ResolvedS2sConfig,
  ResolvedVadConfig,
  ResolvedBehaviorConfig,
  VoiceMode,
  SttProviderName,
  TtsProviderName,
} from "./types.js";

// ── Raw input type (mirrors openclaw.plugin.json configSchema) ────────────────

export interface RawConfig {
  discordToken?: string;
  mode?: string;
  stt?: {
    provider?: string;
    fallback?: string;
    deepgram?: {
      apiKey?: string;
      model?: string;
      language?: string;
      endpointing?: number;
      smartFormatting?: boolean;
      keywords?: string[];
    };
    whisper?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      language?: string;
    };
    localWhisper?: {
      modelPath?: string;
      model?: string;
      threads?: number;
    };
  };
  tts?: {
    provider?: string;
    fallback?: string;
    cartesia?: {
      apiKey?: string;
      voiceId?: string;
      model?: string;
      language?: string;
      speed?: number;
    };
    elevenlabs?: {
      apiKey?: string;
      voiceId?: string;
      model?: string;
      stability?: number;
      similarityBoost?: number;
    };
    openai?: {
      apiKey?: string;
      baseUrl?: string;
      voice?: string;
      model?: string;
      speed?: number;
      streamPcm?: boolean;
    };
    kokoro?: {
      voiceId?: string;
      speed?: number;
    };
  };
  s2s?: {
    provider?: string;
    openaiRealtime?: {
      apiKey?: string;
      model?: string;
      voice?: string;
      instructions?: string;
      temperature?: number;
    };
    geminiLive?: {
      apiKey?: string;
      model?: string;
      voice?: string;
      instructions?: string;
      sessionDurationMs?: number;
    };
  };
  vad?: {
    engine?: string;
    threshold?: number;
    silenceDurationMs?: number;
    minSpeechDurationMs?: number;
  };
  behavior?: {
    bargeIn?: boolean;
    echoSuppression?: boolean;
    maxRecordingMs?: number;
    maxConversationTurns?: number;
    systemPrompt?: string;
    allowedUsers?: string[];
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function env(key: string): string {
  return process.env[key] ?? "";
}

function requireField(value: string | undefined, envKey: string, fieldName: string): string {
  const resolved = value || env(envKey);
  if (!resolved) {
    throw new Error(
      `[discord-voice] Missing required config field "${fieldName}". ` +
      `Set it in config or via the ${envKey} environment variable.`
    );
  }
  return resolved;
}

function assertVoiceMode(value: string): VoiceMode {
  if (value === "auto" || value === "pipeline" || value === "speech-to-speech") return value;
  throw new Error(`[discord-voice] Invalid mode "${value}". Must be auto, pipeline, or speech-to-speech.`);
}

// ── Main resolver ─────────────────────────────────────────────────────────────

export function resolveConfig(raw: RawConfig): ResolvedConfig {
  const stt = resolveStt(raw.stt);
  const tts = resolveTts(raw.tts);
  const s2s = resolveS2s(raw.s2s);
  const vad = resolveVad(raw.vad);
  const behavior = resolveBehavior(raw.behavior);

  // Also accept DISCORD_BOT_TOKEN as an alternate env name — common in deployments
  // that already export the token under that name, and it keeps the token available
  // even when the runtime redacts the sensitive config field.
  const discordToken = requireField(
    raw.discordToken || env("DISCORD_BOT_TOKEN"),
    "DISCORD_TOKEN",
    "discordToken",
  );

  const mode = assertVoiceMode(raw.mode ?? "auto");

  return { discordToken, mode, stt, tts, s2s, vad, behavior };
}

function resolveStt(raw?: RawConfig["stt"]): ResolvedSttConfig {
  return {
    provider: (raw?.provider ?? "deepgram") as SttProviderName,
    fallback: (raw?.fallback ?? "whisper") as SttProviderName,
    deepgram: {
      apiKey: raw?.deepgram?.apiKey || env("DEEPGRAM_API_KEY"),
      model: raw?.deepgram?.model ?? "nova-3",
      language: raw?.deepgram?.language ?? "en",
      endpointing: raw?.deepgram?.endpointing ?? 300,
      smartFormatting: raw?.deepgram?.smartFormatting ?? true,
      keywords: raw?.deepgram?.keywords ?? [],
    },
    whisper: {
      apiKey: raw?.whisper?.apiKey || env("OPENAI_API_KEY"),
      baseUrl: raw?.whisper?.baseUrl || env("OPENAI_BASE_URL") || "https://api.openai.com/v1",
      model: raw?.whisper?.model ?? "whisper-1",
      language: raw?.whisper?.language ?? "en",
    },
    localWhisper: {
      modelPath: raw?.localWhisper?.modelPath,
      model: raw?.localWhisper?.model ?? "base.en",
      threads: raw?.localWhisper?.threads ?? 4,
    },
  };
}

function resolveTts(raw?: RawConfig["tts"]): ResolvedTtsConfig {
  return {
    provider: (raw?.provider ?? "cartesia") as TtsProviderName,
    fallback: (raw?.fallback ?? "elevenlabs") as TtsProviderName,
    cartesia: {
      apiKey: raw?.cartesia?.apiKey || env("CARTESIA_API_KEY"),
      voiceId: raw?.cartesia?.voiceId ?? "79a125e8-cd45-4c13-8a67-188112f4dd22",
      model: raw?.cartesia?.model ?? "sonic-2",
      language: raw?.cartesia?.language ?? "en",
      speed: raw?.cartesia?.speed ?? 1.0,
    },
    elevenlabs: {
      apiKey: raw?.elevenlabs?.apiKey || env("ELEVENLABS_API_KEY"),
      voiceId: raw?.elevenlabs?.voiceId ?? "21m00Tcm4TlvDq8ikWAM",
      model: raw?.elevenlabs?.model ?? "eleven_flash_v2_5",
      stability: raw?.elevenlabs?.stability ?? 0.5,
      similarityBoost: raw?.elevenlabs?.similarityBoost ?? 0.75,
    },
    openai: {
      apiKey: raw?.openai?.apiKey || env("OPENAI_API_KEY"),
      baseUrl: raw?.openai?.baseUrl || env("OPENAI_BASE_URL") || "https://api.openai.com/v1",
      voice: raw?.openai?.voice ?? "nova",
      model: raw?.openai?.model ?? "tts-1",
      speed: raw?.openai?.speed ?? 1.0,
      streamPcm: raw?.openai?.streamPcm ?? false,
    },
    kokoro: {
      voiceId: raw?.kokoro?.voiceId ?? "af_heart",
      speed: raw?.kokoro?.speed ?? 1.0,
    },
  };
}

function resolveS2s(raw?: RawConfig["s2s"]): ResolvedS2sConfig {
  return {
    provider: raw?.provider as ResolvedS2sConfig["provider"],
    openaiRealtime: {
      apiKey: raw?.openaiRealtime?.apiKey || env("OPENAI_API_KEY"),
      model: raw?.openaiRealtime?.model ?? "gpt-4o-realtime-preview",
      voice: raw?.openaiRealtime?.voice ?? "alloy",
      instructions: raw?.openaiRealtime?.instructions,
      temperature: raw?.openaiRealtime?.temperature ?? 0.8,
    },
    geminiLive: {
      apiKey: raw?.geminiLive?.apiKey || env("GOOGLE_API_KEY"),
      model: raw?.geminiLive?.model ?? "gemini-2.5-flash-native-audio-preview",
      voice: raw?.geminiLive?.voice ?? "Puck",
      instructions: raw?.geminiLive?.instructions,
      sessionDurationMs: raw?.geminiLive?.sessionDurationMs ?? 540_000,
    },
  };
}

function resolveVad(raw?: RawConfig["vad"]): ResolvedVadConfig {
  return {
    engine: (raw?.engine ?? "silero") as ResolvedVadConfig["engine"],
    threshold: raw?.threshold ?? 0.5,
    silenceDurationMs: raw?.silenceDurationMs ?? 1_500,
    minSpeechDurationMs: raw?.minSpeechDurationMs ?? 250,
  };
}

function resolveBehavior(raw?: RawConfig["behavior"]): ResolvedBehaviorConfig {
  return {
    bargeIn: raw?.bargeIn ?? true,
    echoSuppression: raw?.echoSuppression ?? true,
    maxRecordingMs: raw?.maxRecordingMs ?? 30_000,
    maxConversationTurns: raw?.maxConversationTurns ?? 50,
    systemPrompt: raw?.systemPrompt,
    allowedUsers: raw?.allowedUsers ?? [],
  };
}

// ── Provider availability checks ──────────────────────────────────────────────

export function hasS2sCredentials(config: ResolvedConfig): boolean {
  const { s2s } = config;
  if (!s2s.provider) return false;
  if (s2s.provider === "openai-realtime") return !!s2s.openaiRealtime.apiKey;
  if (s2s.provider === "gemini-live") return !!s2s.geminiLive.apiKey;
  return false;
}

export function hasSttCredentials(config: ResolvedConfig): boolean {
  const { stt } = config;
  if (stt.provider === "deepgram") return !!stt.deepgram.apiKey;
  if (stt.provider === "whisper") return !!stt.whisper.apiKey;
  if (stt.provider === "local-whisper") return true;
  return false;
}

export function hasTtsCredentials(config: ResolvedConfig): boolean {
  const { tts } = config;
  if (tts.provider === "cartesia") return !!tts.cartesia.apiKey;
  if (tts.provider === "elevenlabs") return !!tts.elevenlabs.apiKey;
  if (tts.provider === "openai") return !!tts.openai.apiKey;
  if (tts.provider === "kokoro") return true;
  return false;
}
