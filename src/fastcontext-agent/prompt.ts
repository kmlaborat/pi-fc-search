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
  
  const template = readFileSync(systemMdPath, "utf-8").trim();

  // Collect substitution variables
  const osKind = process.platform; // "win32", "darwin", "linux" etc.
  const shellName = process.env.SHELL || "bash"; // fallback for Windows where env is typically unset
  
  // Get workspace directory listing (top-level entries only, like Python's os.listdir)
  let workDirLs = "";
  try {
    const entries = readdirSync(workDir);
    workDirLs = entries.join("\n");
  } catch {
    workDirLs = "[unable to read directory]";
  }

  // Perform ${VAR} substitution (simple string replace, not regex)
  return template
    .replace(/\${OS_KIND}/g, osKind)
    .replace(/\${SHELL_NAME}/g, shellName)
    .replace(/\${WORK_DIR}/g, workDir)
    .replace(/\${WORK_DIR_LS}/g, workDirLs);
}
