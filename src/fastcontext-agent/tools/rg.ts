/**
 * Ripgrep binary resolver - single source of truth.
 * Consolidates ripgrep path resolution from multiple tool implementations.
 */

import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";

const _cachedRgPath: { value?: string; error?: Error; resolved: boolean } = {
  value: undefined,
  error: undefined,
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
  // Return cached result if available
  if (_cachedRgPath.resolved) {
    if (_cachedRgPath.error) throw _cachedRgPath.error;
    return _cachedRgPath.value!;
  }

  try {
    // 1. Environment variable (highest priority, SPEC §10.1).
    // (D-015, SPEC §18): validate existence and cache the outcome like the
    // other strategies — a stale value must fail fast with an actionable
    // message instead of surfacing later as an opaque spawn error, and the
    // resolution must not be re-run on every tool call.
    const envRg = process.env.RIPGREP_PATH;
    if (envRg) {
      if (!existsSync(envRg)) {
        const error = new Error(`RIPGREP_PATH is set to \`${envRg}\`, which does not exist.`);
        _cachedRgPath.error = error;
        _cachedRgPath.resolved = true;
        throw error;
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

    const error = new Error("Ripgrep not found. Install @vscode/ripgrep or ensure 'rg' is on PATH.");
    _cachedRgPath.error = error;
    _cachedRgPath.resolved = true;
    throw error;
  } catch (error) {
    if (error instanceof Error) {
      _cachedRgPath.error = error;
    } else {
      const wrapped = new Error(String(error));
      _cachedRgPath.error = wrapped;
    }
    _cachedRgPath.resolved = true;
    throw (_cachedRgPath.error as Error);
  }
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
