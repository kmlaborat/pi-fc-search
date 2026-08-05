/**
 * Ripgrep binary resolver - single source of truth.
 * Consolidates ripgrep path resolution from multiple tool implementations.
 */

import { spawnSync } from "child_process";

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
    // 1. Environment variable (highest priority)
    if (process.env.RIPGREP_PATH) {
      return process.env.RIPGREP_PATH;
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
