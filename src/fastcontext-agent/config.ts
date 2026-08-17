/**
 * LLM configuration resolved from FASTCONTEXT_* environment variables.
 *
 * (SPEC §19, v3 general-model redesign) v2 pinned temperature=1.0,
 * max_tokens=32000 and a 120s timeout in code (values tuned for the retired
 * Microsoft FastContext model). v3 makes all of them operator-configurable
 * because the package now targets general small agentic models on arbitrary
 * OpenAI-compatible endpoints — including CPU-served local models, where the
 * fixed 120s timeout and 1.0 sampling were impractical.
 */

export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_MAX_TOKENS = 32000;
export const DEFAULT_TIMEOUT_SECONDS = 120;

export interface FastContextEnvConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
}

function parseNumber(
  envValue: string | undefined,
  fallback: number,
  label: string,
  validate: (n: number) => boolean
): number {
  if (envValue === undefined || envValue.trim() === "") {
    return fallback;
  }
  const n = Number(envValue);
  if (!validate(n)) {
    console.warn(
      `[pi-fc-search] Invalid ${label}="${envValue}" — must be a number. Using default ${fallback}.`
    );
    return fallback;
  }
  return n;
}

/**
 * Read the full FASTCONTEXT_* configuration from process.env.
 * Call AFTER loadEnvFile() so package .env values participate.
 * Invalid numeric values fall back to defaults with a console warning
 * (a misconfigured .env must not break extension startup).
 */
export function loadFastContextConfig(): FastContextEnvConfig {
  return {
    model: process.env.FASTCONTEXT_MODEL || "",
    apiKey: process.env.FASTCONTEXT_API_KEY || "",
    baseUrl: process.env.FASTCONTEXT_ENDPOINT || "",
    temperature: parseNumber(
      process.env.FASTCONTEXT_TEMPERATURE,
      DEFAULT_TEMPERATURE,
      "FASTCONTEXT_TEMPERATURE",
      (n) => Number.isFinite(n) && n >= 0 && n <= 2
    ),
    maxTokens: parseNumber(
      process.env.FASTCONTEXT_MAX_TOKENS,
      DEFAULT_MAX_TOKENS,
      "FASTCONTEXT_MAX_TOKENS",
      (n) => Number.isInteger(n) && n > 0
    ),
    timeoutSeconds: parseNumber(
      process.env.FASTCONTEXT_TIMEOUT_SECONDS,
      DEFAULT_TIMEOUT_SECONDS,
      "FASTCONTEXT_TIMEOUT_SECONDS",
      (n) => Number.isInteger(n) && n >= 5
    ),
  };
}
