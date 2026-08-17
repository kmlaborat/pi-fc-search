/**
 * Ripgrep binary resolver - single source of truth.
 * Consolidates ripgrep path resolution from multiple tool implementations.
 */

import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";

// (D-028, SPEC §18) only successful resolutions are cached: a failed
// resolution (e.g. a stale RIPGREP_PATH that is later fixed, or a
// transiently unavailable bundled module) must be retried on the next
// call instead of being replayed forever.
const _cachedRgPath: { value?: string; resolved: boolean } = {
  value: undefined,
  resolved: false,
};

/**
 * Resolve the path to ripgrep binary. Results are cached after first resolution.
 * Resolution order:
 * 1. Environment variable RIPGREP_PATH
 * 2. Bundled from @vscode/ripgrep package
 * 3. System PATH (via which/where command, no shell:true)
 */
export async function getRgPath(): Promise<string> {
  // Return cached result if available (successes only — see D-028)
  if (_cachedRgPath.resolved) {
    return _cachedRgPath.value!;
  }

  // 1. Environment variable (highest priority, SPEC §10.1).
  // (D-015, SPEC §18): validate existence so a stale value fails fast with
  // an actionable message instead of surfacing later as an opaque spawn
  // error. (D-028, SPEC §18): the failure is NOT cached — only a successful
  // resolution is, so a fixed RIPGREP_PATH takes effect on the next call
  // within the same process.
  const envRg = process.env.RIPGREP_PATH;
  if (envRg) {
    if (!existsSync(envRg)) {
      throw new Error(`RIPGREP_PATH is set to \`${envRg}\`, which does not exist.`);
    }
    _cachedRgPath.value = envRg;
    _cachedRgPath.resolved = true;
    return envRg;
  }

  // 2. Bundled from @vscode/ripgrep (recommended)
  try {
    const rgModule = await import("@vscode/ripgrep");
    if (rgModule.rgPath) {
      _cachedRgPath.value = rgModule.rgPath;
      _cachedRgPath.resolved = true;
      return rgModule.rgPath;
    }
  } catch (error) {
    console.warn("[fastcontext] Warning: Failed to load @vscode/ripgrep, trying system PATH");
  }

  // 3. System PATH fallback - no shell:true as per SPEC A.7
  const command = process.platform === "win32" ? "where" : "which";

  try {
    const result = spawnSync(command, ["rg"], { shell: false });
    if (result.status === 0) {
      // On Windows, `where` can return multiple paths - use the first one
      const output = result.stdout.toString().trim();
      const pathResult = output.split(/\r?\n/)[0].trim();
      if (pathResult) {
        console.warn(`[fastcontext] Warning: Using system ripgrep from ${pathResult}`);
        _cachedRgPath.value = pathResult;
        _cachedRgPath.resolved = true;
        return pathResult;
      }
    }
  } catch {
    // Ignore fallback errors
  }

  // (D-028, SPEC §18): not cached — the next call retries resolution.
  throw new Error("Ripgrep not found. Install @vscode/ripgrep or ensure 'rg' is on PATH.");
}

/**
 * Run the ripgrep binary with the given arguments.
 *
 * Single source of truth for ripgrep spawn handling (timeout, exit codes,
 * error messages) shared by all tools. Behavior:
 * - kills the child process after `timeoutSeconds`
 * - exit code 1 (no matches / no files) resolves with whatever stdout was
 *   produced (usually empty) — it is not an error
 * - any other exit code rejects with stderr (or the exit code)
 */
export async function runRipgrep(
  args: string[],
  cwd: string,
  timeoutSeconds: number
): Promise<string> {
  const rgPath = await getRgPath();

  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, shell: false });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error(`Tool timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);

      // ripgrep exits with 1 when nothing matches — that is success for us
      if (code === 0 || code === 1) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Ripgrep exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
  });
}
