// ── Audio constants ───────────────────────────────────────────────────────────

/** Discord's native sample rate for voice */
export const DISCORD_SAMPLE_RATE = 48_000;

/** Target sample rate for STT and VAD processing */
export const PROCESSING_SAMPLE_RATE = 16_000;

/** Discord sends stereo audio */
export const DISCORD_CHANNELS = 2;

/** Processing uses mono */
export const PROCESSING_CHANNELS = 1;

/** Duration of each Discord Opus frame in milliseconds */
export const OPUS_FRAME_DURATION_MS = 20;

/** Bytes per sample for 16-bit PCM */
export const BYTES_PER_SAMPLE = 2;

// ── Timing ────────────────────────────────────────────────────────────────────

/** After bot finishes speaking, suppress echo for this many ms */
export const ECHO_COOLDOWN_MS = 300;

/** Minimum pause to consider a new utterance distinct */
export const SPEAK_COOLDOWN_MS = 500;

/** Heartbeat interval for monitoring Discord voice connection health */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** How long to wait before attempting to reconnect a dropped connection */
export const RECONNECT_DELAY_MS = 5_000;

/** Maximum reconnection attempts before giving up */
export const RECONNECT_MAX_ATTEMPTS = 5;

/** Base delay for exponential backoff on WebSocket reconnects */
export const WS_RECONNECT_BASE_DELAY_MS = 500;

// ── VAD thresholds (for RMS fallback engine) ──────────────────────────────────

export const RMS_THRESHOLD_LOW = 400;
export const RMS_THRESHOLD_MEDIUM = 800;
export const RMS_THRESHOLD_HIGH = 1_200;

// ── Pipeline engine ───────────────────────────────────────────────────────────

/** Maximum characters sent to TTS in one request (safety cap) */
export const TTS_MAX_CHARS = 4_000;

/** Deepgram WebSocket keep-alive ping interval */
export const DEEPGRAM_PING_INTERVAL_MS = 10_000;

/** Gemini Live session rotation buffer before 10-min hard limit */
export const GEMINI_SESSION_ROTATION_BUFFER_MS = 60_000;

// ── Sentence splitting ────────────────────────────────────────────────────────

/** Regex to detect sentence boundaries for pipeline TTS pipelining */
export const SENTENCE_BOUNDARY_RE = /([.!?])\s+/;
