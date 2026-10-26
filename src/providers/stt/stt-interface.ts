import type {
  SttProvider, SttStream, SttResult, SttStreamOptions, SttBatchOptions,
  ResolvedSttConfig,
} from "../../types.js";

// Re-export everything from types so consumers only import from this module
export type { SttProvider, SttStream, SttResult, SttStreamOptions, SttBatchOptions };

/**
 * Create an STT provider by name.
 * Lazy imports to avoid loading heavy deps (onnx, etc.) unless needed.
 */
export async function createSttProvider(
  name: "deepgram" | "whisper" | "local-whisper",
  config: ResolvedSttConfig
): Promise<SttProvider> {
  switch (name) {
    case "deepgram": {
      const { DeepgramStt } = await import("./deepgram-stt.js");
      return new DeepgramStt(config.deepgram);
    }
    case "whisper": {
      const { WhisperStt } = await import("./whisper-stt.js");
      return new WhisperStt(config.whisper);
    }
    case "local-whisper": {
      const { LocalWhisperStt } = await import("./local-whisper-stt.js");
      return new LocalWhisperStt(config.localWhisper);
    }
  }
}
