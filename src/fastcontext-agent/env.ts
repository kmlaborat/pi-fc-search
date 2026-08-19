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

// (D-057, SPEC §18) Result of a .env (re)load. Lets the /reload-env command
// report exactly what happened without re-parsing the file itself.
export interface ReloadEnvResult {
  /** The resolved package-root .env path. */
  envPath: string;
  /** Whether the .env file exists. */
  found: boolean;
  /** FASTCONTEXT_* keys written into process.env by this load. */
  appliedKeys: string[];
  /** Non-prefixed keys that were ignored (D-018). */
  ignoredKeys: string[];
}

/**
 * Resolve the package-root .env path (two levels up from this file:
 * src/fastcontext-agent/env.ts → <package root>/.env).
 */
export function getEnvPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
}

/**
 * Read the package .env and apply its FASTCONTEXT_* keys into process.env.
 *
 * (D-057, SPEC §18) Re-runnable: unlike loadEnvFile() this performs the file
 * read on EVERY call, so editing the .env file and re-invoking picks up new
 * values without a pi restart. Combined with D-037's per-call
 * loadFastContextConfig(), a /reload-env then the next fc_search call uses
 * the corrected configuration.
 *
 * Semantics preserved from the original loader:
 * - Only FASTCONTEXT_* keys are applied (D-018); others are reported in
 *   ignoredKeys with a warning.
 * - Applied values override existing process.env entries (D-012 precedence).
 * - Keys REMOVED from the .env file are NOT removed from process.env: this
 *   function only ever writes, matching applyEnvContent()'s overwrite-only
 *   contract (documented in D-057).
 * - A missing or unreadable .env never throws; it is reported in the result.
 */
export function reloadEnvFile(): ReloadEnvResult {
  const envPath = getEnvPath();

  if (!existsSync(envPath)) {
    return { envPath, found: false, appliedKeys: [], ignoredKeys: [] };
  }

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch (error) {
    // Warn but continue — a broken .env must not break the command.
    console.error(
      `[pi-fc-search] Warning: Failed to load .env file: ${error instanceof Error ? error.message : String(error)}. API key and configuration may not be available.`
    );
    return { envPath, found: true, appliedKeys: [], ignoredKeys: [] };
  }

  const ignoredKeys = applyEnvContent(content, process.env);
  if (ignoredKeys.length > 0) {
    // (D-018, SPEC §18) surface misconfiguration without acting on it.
    console.warn(
      `[pi-fc-search] Ignored non-FASTCONTEXT_* key(s) in .env: ${ignoredKeys.join(", ")} ` +
      "(only FASTCONTEXT_* variables are loaded from the package .env)"
    );
  }

  // Derive the applied keys with the same parsing rules as applyEnvContent()
  // (trim, skip blanks/comments, first '=' split, prefix filter).
  const appliedKeys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    if (key.startsWith(ENV_KEY_PREFIX)) appliedKeys.push(key);
  }

  return { envPath, found: true, appliedKeys, ignoredKeys };
}

let loaded = false;

export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;
  // (D-057, SPEC §18) The initial module-init load shares the same code path
  // as runtime reloads; only the once-guard differs.
  reloadEnvFile();
}
