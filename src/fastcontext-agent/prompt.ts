/**
 * System prompt template loader and processor.
 * Ported from src/fastcontext/agent/utils.py
 */

import { readFile, readdir } from "fs/promises";
import { dirname, resolve as pathResolve } from "path";
import { fileURLToPath } from "url";

// Simple template engine using ${VAR} substitution (no Jinja2 dependency)

// (D-055, SPEC §18) async: the previous readFileSync/readdirSync were the
// last synchronous fs calls in the agent — on a slow or networked working
// filesystem the top-level readdir blocked the host (pi) event loop for
// every search, the exact failure class the Read/Glob tools' sync→async
// fixes removed. The bundled system.md read is made async too for
// consistency. Callers: runFastContextAgent (already async) awaits it
// before constructing the Agent.
export async function loadSystemPrompt(workDir: string): Promise<string> {
  // Load system.md from package directory
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const systemMdPath = pathResolve(__dirname, "system.md");

  // Load and normalize line endings to LF (prevents CRLF issues in LLM requests)
  const template = (await readFile(systemMdPath, "utf-8"))
    .replace(/\r\n/g, "\n")
    .trim();

  // Get workspace directory listing (top-level entries only, like Python's os.listdir)
  let workDirLs = "";
  try {
    const entries = await readdir(workDir);
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
