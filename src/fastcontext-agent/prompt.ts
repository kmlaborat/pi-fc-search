/**
 * System prompt template loader and processor.
 * Ported from src/fastcontext/agent/utils.py
 */

import { readFileSync, readdirSync } from "fs";
import { dirname, resolve as pathResolve } from "path";
import { fileURLToPath } from "url";

// Simple template engine using ${VAR} substitution (no Jinja2 dependency)

export function loadSystemPrompt(workDir: string): string {
  // Load system.md from package directory
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const systemMdPath = pathResolve(__dirname, "system.md");
  
  // Load and normalize line endings to LF (prevents CRLF issues in LLM requests)
  const template = readFileSync(systemMdPath, "utf-8")
    .replace(/\r\n/g, "\n")
    .trim();

  // Get workspace directory listing (top-level entries only, like Python's os.listdir)
  let workDirLs = "";
  try {
    const entries = readdirSync(workDir);
    workDirLs = entries.join("\n");
  } catch {
    workDirLs = "[unable to read directory]";
  }

  // Perform ${VAR} substitution (simple string replace, not regex).
  // (SPEC §19 v3) the v2 template also substituted OS_KIND and SHELL_NAME;
  // both were informational leftovers from the upstream prompt and were
  // dropped because the sub-agent cannot execute shell commands.
  return template
    .replace(/\${WORK_DIR}/g, workDir)
    .replace(/\${WORK_DIR_LS}/g, workDirLs);
}
