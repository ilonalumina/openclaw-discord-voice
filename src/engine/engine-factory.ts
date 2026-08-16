import type { VoiceEngine } from "./engine-interface.js";
import { PipelineEngine } from "./pipeline-engine.js";
import { SpeechToSpeechEngine } from "./speech-to-speech-engine.js";
import type { CoreBridge } from "../core-bridge.js";
import type { ResolvedConfig } from "../types.js";
import { hasS2sCredentials } from "../config.js";

/**
 * Creates the appropriate VoiceEngine based on the resolved config.
 *
 * Mode selection for "auto":
 *   - Prefers speech-to-speech when an S2S provider is configured and has valid credentials
 *   - Falls back to pipeline when S2S is not configured or credentials are missing
 */
export function createEngine(config: ResolvedConfig, coreBridge: CoreBridge): VoiceEngine {
  const mode = resolveMode(config);

  if (mode === "speech-to-speech") {
    return new SpeechToSpeechEngine(coreBridge, config.behavior.maxConversationTurns);
  }

  return new PipelineEngine(coreBridge, config.behavior.maxConversationTurns);
}

function resolveMode(config: ResolvedConfig): "speech-to-speech" | "pipeline" {
  if (config.mode === "speech-to-speech") {
    if (!hasS2sCredentials(config)) {
      console.warn(
        "[engine-factory] Mode is 'speech-to-speech' but no S2S credentials found. " +
        "Falling back to pipeline mode."
      );
      return "pipeline";
    }
    return "speech-to-speech";
  }

  if (config.mode === "pipeline") {
    return "pipeline";
  }

  // "auto": prefer speech-to-speech if credentials available
  if (hasS2sCredentials(config)) {
    return "speech-to-speech";
  }

  return "pipeline";
}
