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

      // (D-012, SPEC §18) The installed package .env is the single source of
      // truth: values here override variables already present in the process
      // environment (the reverse of standard dotenv precedence; supersedes
      // D-011). Stale shell/CI exports must not silently shadow the model and
      // endpoint the user configured in the package .env.
      process.env[key] = value;
    }
  } catch (error) {
    // Warn but continue — a broken .env must not break extension startup
    console.error(
      `[pi-fc-search] Warning: Failed to load .env file: ${error instanceof Error ? error.message : String(error)}. API key and configuration may not be available.`
    );
  }
}
