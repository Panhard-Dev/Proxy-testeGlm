/*
 * File: telemetry.ts
 * Project: deepsproxy
 * Context limit management (QwenProxy-style): the limit is a KNOWN value from
 * configuration, never guessed from failures. Failures are logged for
 * observability only — a network/browser error says nothing about the context
 * window, and guessing from them poisons the limit (see history: this made the
 * compressor destroy agent histories on every request).
 */

export interface ModelTelemetry {
  detectedLimit: number; // in characters
  maxSuccessSize: number; // in characters (observability)
}

const MIN_CONTEXT_CHARACTERS = 4_000 * 3.5; // ~14,000 characters floor

// Read lazily (at first telemetry use, not module load) because ESM evaluates
// imports before dotenv.config() runs in index.ts.
function getDefaultContextCharacters(): number {
  const tokens = Number(process.env.CONTEXT_TOKENS) || 64_000;
  return tokens * 3.5;
}

const telemetryStore: Record<string, ModelTelemetry> = (globalThis as any)._telemetryStore || {};
(globalThis as any)._telemetryStore = telemetryStore;

function initTelemetry(model: string): ModelTelemetry {
  if (!telemetryStore[model]) {
    telemetryStore[model] = {
      detectedLimit: getDefaultContextCharacters(),
      maxSuccessSize: 0,
    };
  }
  return telemetryStore[model];
}

export function getModelTelemetry(model: string): ModelTelemetry {
  return initTelemetry(model);
}

export function getContextLength(model: string): number {
  const stats = initTelemetry(model);
  // Return in tokens (assuming roughly 3.5 characters per token)
  return Math.ceil(stats.detectedLimit / 3.5);
}

export function recordSuccess(model: string, promptSize: number): void {
  const stats = initTelemetry(model);
  stats.maxSuccessSize = Math.max(stats.maxSuccessSize, promptSize);

  // The limit only ever grows: a successful prompt larger than the configured
  // limit proves the real window is at least that big. Failures NEVER shrink it.
  if (promptSize > stats.detectedLimit) {
    stats.detectedLimit = promptSize;
  }

  console.log(`[Telemetry] Success for model '${model}'. Prompt size: ${promptSize} chars. Context limit: ${stats.detectedLimit} chars (~${Math.ceil(stats.detectedLimit / 3.5)} tokens).`);
}

export function recordFailure(model: string, promptSize: number, errorMessage?: string): void {
  // Observability only. The context limit is configuration, not a guess:
  // shrinking it on failures (even real-looking ones) caused the compressor
  // to silently destroy agent histories. If a prompt truly exceeds the
  // window, the pre-check in chat.ts rejects it with a clean 400 instead.
  console.log(`[Telemetry] Failure for model '${model}'. Prompt size: ${promptSize} chars. Error: ${errorMessage || 'unknown'}. Context limit unchanged: ${initTelemetry(model).detectedLimit} chars.`);
}
