import type { SttProvider, SttBatchOptions, SttResult } from "../../types.js";
import type { ResolvedLocalWhisperConfig } from "../../types.js";

/**
 * Local Whisper STT provider — DISABLED in this fork.
 *
 * Upstream ran a local whisper.cpp binary, which OpenClaw's plugin installer
 * flags as a dangerous code pattern and refuses to install. This fork drives
 * STT through an OpenAI-compatible HTTP endpoint instead (the `whisper`
 * provider with a `baseUrl`, e.g. Speaches), so the local binary path is
 * removed entirely.
 *
 * Selecting `stt.provider: "local-whisper"` will throw. Use
 * `stt.provider: "whisper"` with a `baseUrl` pointing at an OpenAI-compatible
 * transcription endpoint.
 */
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
