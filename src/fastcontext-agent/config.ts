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
export const DEFAULT_TOP_P = 0.95;
export const DEFAULT_MAX_TOKENS = 32000;
export const DEFAULT_TIMEOUT_SECONDS = 120;

export interface FastContextEnvConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  // (D-030, SPEC §18) top_p was a code constant (0.95) while the other v3
  // sampling settings were operator-configurable; FASTCONTEXT_TOP_P closes
  // that gap.
  topP: number;
  maxTokens: number;
  timeoutSeconds: number;
}

function parseNumber(
  envValue: string | undefined,
  fallback: number,
  label: string,
  validate: (n: number) => boolean,
  // (D-045, SPEC §18) integer settings accept only decimal integer
  // literals: Number("1e3") === 1000 and Number("0x10") === 16 would
  // otherwise silently accept notations no operator would write down.
  integerLiteral = false
): number {
  if (envValue === undefined || envValue.trim() === "") {
    return fallback;
  }
  const trimmed = envValue.trim();
  if (integerLiteral && !/^\d+$/.test(trimmed)) {
    console.warn(
      `[pi-fc-search] Invalid ${label}="${envValue}" — must be a non-negative integer. Using default ${fallback}.`
    );
    return fallback;
  }
  const n = Number(trimmed);
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
/**
 * Validate a candidate FASTCONTEXT_ENDPOINT value.
 *
 * (D-026, SPEC §18) An endpoint that is not an absolute http(s) URL (e.g.
 * a missing scheme: "example.com/v1") makes fetch throw a TypeError on
 * every attempt — which the D-023 retry loop would misclassify as a
 * transient network failure, burn two retries and backoffs, and finally
 * report as "LLM API call failed: Failed to parse URL". Validating at the
 * extension's fail-fast point instead turns the misconfiguration into an
 * immediate, actionable ConfigurationError.
 *
 * Returns null when the value is a valid http(s) base URL, otherwise an
 * actionable error message.
 */
export function validateEndpointUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return (
      `FASTCONTEXT_ENDPOINT="${value}" is not a valid URL. ` +
      `It must be an absolute http(s) base URL such as https://host:port/v1.`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return (
      `FASTCONTEXT_ENDPOINT="${value}" uses protocol "${url.protocol}"; ` +
      `only http:// and https:// endpoints are supported.`
    );
  }
  return null;
}

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
    topP: parseNumber(
      process.env.FASTCONTEXT_TOP_P,
      DEFAULT_TOP_P,
      "FASTCONTEXT_TOP_P",
      (n) => Number.isFinite(n) && n >= 0 && n <= 1
    ),
    maxTokens: parseNumber(
      process.env.FASTCONTEXT_MAX_TOKENS,
      DEFAULT_MAX_TOKENS,
      "FASTCONTEXT_MAX_TOKENS",
      (n) => Number.isInteger(n) && n > 0,
      true // D-045, SPEC §18
    ),
    timeoutSeconds: parseNumber(
      process.env.FASTCONTEXT_TIMEOUT_SECONDS,
      DEFAULT_TIMEOUT_SECONDS,
      "FASTCONTEXT_TIMEOUT_SECONDS",
      (n) => Number.isInteger(n) && n >= 5,
      true // D-045, SPEC §18
    ),
  };
}
