/**
 * Shared .env loader for the package.
 *
 * Single source of truth for loading FASTCONTEXT_* variables from the
 * package-root `.env` file. Idempotent — safe to call from multiple modules
 * (extension entry point and LLM client both call it at init time).
 */

import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// (D-018, SPEC §18) Only keys with this prefix are applied. The old loader
// wrote ANY `KEY=VALUE` line into process.env (and, per D-012, overrode the
// shell environment) — a .env line such as `PATH=...` or `NODE_ENV=...`
// would silently hijack the host pi process. Non-prefixed keys are now
// ignored with a warning.
export const ENV_KEY_PREFIX = "FASTCONTEXT_";

/**
 * Parse .env content and apply `FASTCONTEXT_*` keys into `env`.
 *
 * Pure function (no fs / no global state) so the parsing rules — quoting,
 * comments, prefix filtering, D-012 precedence — are unit-testable without
 * touching the real process environment.
 *
 * Returns the list of ignored (non-prefixed) keys, for callers that want
 * to warn.
 */
export function applyEnvContent(
  content: string,
  env: NodeJS.ProcessEnv
): string[] {
  const ignoredKeys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Parse KEY=VALUE format
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!key.startsWith(ENV_KEY_PREFIX)) {
      ignoredKeys.push(key);
      continue;
    }

    // (D-012, SPEC §18) The installed package .env is the single source of
    // truth: values here override variables already present in the process
    // environment (the reverse of standard dotenv precedence; supersedes
    // D-011). Stale shell/CI exports must not silently shadow the model and
    // endpoint the user configured in the package .env.
    env[key] = value;
  }
  return ignoredKeys;
}

let loaded = false;

export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;

  // Resolve .env at the package root (two levels up from this file:
  // src/fastcontext-agent/env.ts → <package root>/.env)
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");

  if (!existsSync(envPath)) {
    return;
  }

  try {
    const content = readFileSync(envPath, "utf-8");
    const ignoredKeys = applyEnvContent(content, process.env);
    if (ignoredKeys.length > 0) {
      // (D-018, SPEC §18) surface misconfiguration without acting on it.
      console.warn(
        `[pi-fc-search] Ignored non-FASTCONTEXT_* key(s) in .env: ${ignoredKeys.join(", ")} ` +
        "(only FASTCONTEXT_* variables are loaded from the package .env)"
      );
    }
  } catch (error) {
    // Warn but continue — a broken .env must not break extension startup
    console.error(
      `[pi-fc-search] Warning: Failed to load .env file: ${error instanceof Error ? error.message : String(error)}. API key and configuration may not be available.`
    );
  }
}
