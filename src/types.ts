import type { EventEmitter } from "node:events";

// ── Engine ────────────────────────────────────────────────────────────────────

export type EngineMode = "pipeline" | "speech-to-speech";

export type SessionState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking";

export interface VoiceSessionContext {
  guildId: string;
  channelId: string;
  config: ResolvedConfig;
}

// ── Conversation ──────────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: "user" | "assistant";
  userId?: string;
  username?: string;
  content: string;
  timestamp: number;
}

// ── STT ───────────────────────────────────────────────────────────────────────

export interface SttResult {
  text: string;
  confidence?: number | undefined;
  language?: string | undefined;
  isFinal: boolean;
}

export interface SttStreamOptions {
  sampleRate: number;
  channels?: number;
}

export interface SttBatchOptions {
  sampleRate: number;
  language?: string;
}

export interface SttStream extends EventEmitter {
  write(pcm: Buffer): void;
  end(): void;
  close(): void;
  on(event: "partial", handler: (text: string) => void): this;
  on(event: "final", handler: (result: SttResult) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(event: "speech-start", handler: () => void): this;
  on(event: string, handler: (...args: unknown[]) => void): this;
}

export interface SttProvider {
  readonly id: string;
  readonly supportsStreaming: boolean;
  startStream?(options: SttStreamOptions): SttStream;
  transcribe?(audio: Buffer, options: SttBatchOptions): Promise<SttResult>;
  dispose(): Promise<void>;
}

// ── TTS ───────────────────────────────────────────────────────────────────────

export interface TtsOptions {
  speed?: number;
  emotion?: string[];
}

export interface TtsResult {
  audio: Buffer;
  sampleRate: number;
  format: "pcm" | "mp3" | "opus";
}

export interface TtsStream extends EventEmitter {
  cancel(): void;
  on(event: "audio", handler: (chunk: Buffer, sampleRate: number) => void): this;
  on(event: "end", handler: () => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(event: string, handler: (...args: unknown[]) => void): this;
}

export interface TtsProvider {
  readonly id: string;
  readonly supportsStreaming: boolean;
  synthesizeStream(text: string, options?: TtsOptions): TtsStream;
  synthesize?(text: string, options?: TtsOptions): Promise<TtsResult>;
  dispose(): Promise<void>;
}

// ── Speech-to-Speech ──────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface S2sSessionOptions {
  instructions?: string;
  tools?: ToolDefinition[];
  conversationHistory?: ConversationTurn[];
}

export interface S2sSession extends EventEmitter {
  sendAudio(pcm: Buffer): void;
  sendText(text: string): void;
  commitAudio(): void;
  cancelResponse(): void;
  updateTools(tools: ToolDefinition[]): void;
  sendToolResult(callId: string, result: unknown): void;
  close(): Promise<void>;
  on(event: "audio", handler: (chunk: Buffer, sampleRate: number) => void): this;
  on(event: "transcript-in", handler: (text: string) => void): this;
  on(event: "transcript-out", handler: (text: string) => void): this;
  on(event: "tool-call", handler: (call: ToolCall) => void): this;
  on(event: "interrupted", handler: () => void): this;
  on(event: "turn-end", handler: () => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(event: string, handler: (...args: unknown[]) => void): this;
}

export interface S2sProvider {
  readonly id: string;
  connect(options: S2sSessionOptions): Promise<S2sSession>;
}

// ── VAD ───────────────────────────────────────────────────────────────────────

export type VadEventType = "speech-start" | "speech-end";

export interface VadEvent {
  type: VadEventType;
  timestamp: number;
}

// ── Audio ─────────────────────────────────────────────────────────────────────

export interface AudioFingerprint {
  rms: number;
  timestamp: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

export type VoiceMode = "auto" | "pipeline" | "speech-to-speech";
export type SttProviderName = "deepgram" | "whisper" | "local-whisper";
export type TtsProviderName = "cartesia" | "elevenlabs" | "openai" | "kokoro";
export type S2sProviderName = "openai-realtime" | "gemini-live";
export type VadEngine = "silero" | "rms";

export interface ResolvedDeepgramConfig {
  apiKey: string;
  model: string;
  language: string;
  endpointing: number;
  smartFormatting: boolean;
  keywords: string[];
}

export interface ResolvedWhisperConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  language?: string | undefined;
}

export interface ResolvedLocalWhisperConfig {
  modelPath?: string | undefined;
  model: string;
  threads: number;
}

export interface ResolvedCartesiaConfig {
  apiKey: string;
  voiceId: string;
  model: string;
  language: string;
  speed: number;
}

export interface ResolvedElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  model: string;
  stability: number;
  similarityBoost: number;
}

export interface ResolvedOpenAiTtsConfig {
  apiKey: string;
  baseUrl: string;
  voice: string;
  model: string;
  speed: number;
  /**
   * Request generation-streaming PCM (body `stream: true`). Servers that
   * support it emit int16 PCM chunks as they are generated instead of after
   * full synthesis. Leave false for servers implementing the standard OpenAI
   * speech API (which has no stream parameter).
   */
  streamPcm: boolean;
}

export interface ResolvedKokoroConfig {
  voiceId: string;
  speed: number;
}

export interface ResolvedOpenAiRealtimeConfig {
  apiKey: string;
  model: string;
  voice: string;
  instructions?: string | undefined;
  temperature: number;
}

export interface ResolvedGeminiLiveConfig {
  apiKey: string;
  model: string;
  voice: string;
  instructions?: string | undefined;
  sessionDurationMs: number;
}

export interface ResolvedSttConfig {
  provider: SttProviderName;
  fallback: SttProviderName;
  deepgram: ResolvedDeepgramConfig;
  whisper: ResolvedWhisperConfig;
  localWhisper: ResolvedLocalWhisperConfig;
}

export interface ResolvedTtsConfig {
  provider: TtsProviderName;
  fallback: TtsProviderName;
  cartesia: ResolvedCartesiaConfig;
  elevenlabs: ResolvedElevenLabsConfig;
  openai: ResolvedOpenAiTtsConfig;
  kokoro: ResolvedKokoroConfig;
}

export interface ResolvedS2sConfig {
  provider?: S2sProviderName | undefined;
  openaiRealtime: ResolvedOpenAiRealtimeConfig;
  geminiLive: ResolvedGeminiLiveConfig;
}

export interface ResolvedVadConfig {
  engine: VadEngine;
  threshold: number;
  silenceDurationMs: number;
  minSpeechDurationMs: number;
}

export interface ResolvedBehaviorConfig {
  bargeIn: boolean;
  echoSuppression: boolean;
  maxRecordingMs: number;
  maxConversationTurns: number;
  systemPrompt?: string | undefined;
  allowedUsers: string[];
}

export interface ResolvedConfig {
  discordToken: string;
  mode: VoiceMode;
  stt: ResolvedSttConfig;
  tts: ResolvedTtsConfig;
  s2s: ResolvedS2sConfig;
  vad: ResolvedVadConfig;
  behavior: ResolvedBehaviorConfig;
}
