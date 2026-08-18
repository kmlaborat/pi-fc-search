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

// (D-034, SPEC §18) stdout accumulation cap. The Read/Grep line-length
// (D-024) and line-count (D-010) truncation is applied to the FULLY
// accumulated stdout string, so a single pathological match (one
// megabyte-scale line in a minified bundle or log) would otherwise sit
// in memory unbounded before any truncation ran. Once the cap is hit the
// remaining chunks are dropped: the tools' line limits only ever display
// a small prefix of the output, and the 10s spawn timeout still bounds
// the child's runtime.
const MAX_RG_STDOUT_BYTES = 16 * 1024 * 1024; // 16 MB

// (D-050, SPEC §18) optional abort signal (the agent's cancellation /
// total-execution timeout signal). When it aborts, the child is killed
// immediately and the promise rejects with the signal's reason — instead of
// the child running out its own 10s timeout after the search is already
// dead. The timeout behavior is unchanged; the signal is an ADDITIONAL
// stop path.
export async function runRipgrep(
  args: string[],
  cwd: string,
  timeoutSeconds: number,
  signal?: AbortSignal
): Promise<string> {
  const rgPath = await getRgPath();

  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, shell: false });

    const timeoutHandle = setTimeout(() => {
      clearAbortListener();
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Tool timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);

    // (D-050, SPEC §18) abort handling. `settled` guards the double-settle
    // window: after the abort fires, rg's `close` still arrives and must
    // not re-settle (resolve after reject is a no-op, but the listener
    // cleanup below must run exactly once).
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      child.kill();
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("aborted")
      );
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const clearAbortListener = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    // (D-040, SPEC §18) accumulate as Buffer[] and decode exactly once on
    // settle. The previous `stdout += chunk` relied on Buffer's implicit
    // per-chunk UTF-8 conversion, which corrupts a multi-byte character
    // (e.g. CJK in a file name) split across a chunk boundary. The byte cap
    // (D-034/D-038) is now measured in real bytes (chunk.length), not
    // string length.
    let stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutCapReached = false;
    let stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stderrCapReached = false;

    child.stdout.on("data", (chunk: Buffer) => {
      // (D-034, SPEC §18) cap the accumulation — drop chunks once the
      // cap is reached (see MAX_RG_STDOUT_BYTES above).
      if (stdoutCapReached) return;
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RG_STDOUT_BYTES) {
        stdoutCapReached = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // (D-038, SPEC §18) same accumulation cap as stdout (D-034): an rg
      // invocation that dumps megabytes of stderr (e.g. permission-denied
      // lines across a huge tree) would otherwise sit in memory unbounded
      // before the reject surfaces it into a tool result — and the error
      // text is what the sub-agent model would see.
      if (stderrCapReached) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_RG_STDOUT_BYTES) {
        stderrCapReached = true;
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      clearAbortListener();
      if (settled) return; // lost the race to the abort path
      settled = true;

      // (D-040, SPEC §18) single decode of the accumulated bytes (see the
      // chunk handlers above). The chunk handlers retain up to one chunk
      // beyond the cap (the chunk that crosses it is already in memory);
      // trim back to the exact cap so the D-034/D-038 contract (resolved
      // string <= MAX_RG_STDOUT_BYTES) holds. Trimming at the byte level
      // can split a trailing multi-byte character — that tail is
      // pathological output no consumer ever shows, so a U+FFFD there is
      // acceptable.
      const stdout = Buffer.concat(stdoutChunks)
        .subarray(0, MAX_RG_STDOUT_BYTES)
        .toString("utf8");
      const stderr = Buffer.concat(stderrChunks)
        .subarray(0, MAX_RG_STDOUT_BYTES)
        .toString("utf8");

      // ripgrep exits with 1 when nothing matches — that is success for us
      if (code === 0 || code === 1) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Ripgrep exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      clearAbortListener();
      if (settled) return; // lost the race to the abort path
      settled = true;
      reject(err);
    });
  });
}
