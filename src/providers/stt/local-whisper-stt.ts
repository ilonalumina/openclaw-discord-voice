import type { SttProvider, SttBatchOptions, SttResult } from "../../types.js";
import type { ResolvedLocalWhisperConfig } from "../../types.js";

// Disabled: OpenClaw's installer rejects plugins that spawn a local binary.
export class LocalWhisperStt implements SttProvider {
  readonly id = "local-whisper";
  readonly supportsStreaming = false;

  constructor(_config: ResolvedLocalWhisperConfig) {}

  async transcribe(_audio: Buffer, _options: SttBatchOptions): Promise<SttResult> {
    throw new Error(
      'local-whisper is disabled in this build. Set stt.provider to "whisper" with a ' +
      "baseUrl pointing at an OpenAI-compatible transcription endpoint (e.g. Speaches).",
    );
  }

  async dispose(): Promise<void> {}
}
