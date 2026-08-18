/**
 * Opt-in real-server regression test — 2026-08-18 prefill-timeout incident.
 *
 * Re-runs the EXACT query that timed out in the incident (its 43k-token
 * prompt took ~95s of cold prefill on a single LLM call and blew the 120s
 * total-execution timeout), with the timeout explicitly pinned to the
 * DEFAULT 120 seconds — regardless of any temporary .env override (the
 * temporary 600s mitigation must NOT be what makes this pass).
 *
 * Pass criteria (two tiers):
 *
 * A. BEST: the search completes within 120s with a <final_answer>.
 *
 * B. REGRESSION PROPERTY (still passes, with a warning): the run times out,
 *    BUT the timeout is demonstrably NOT the incident's failure mode:
 *      - it occurred after >= 3 turns (the budget was spread across many
 *        turns — model latency/wandering, the documented KN-001 class —
 *        instead of one call consuming the whole budget), and
 *      - no tool result in the trajectory exceeded the 64 KiB Read cap
 *        (D-048), i.e. no incident-class huge read happened.
 *    This tier exists because per-turn latency on a remote 35 tok/s server
 *    makes total runtime proportional to the model's (nondeterministic)
 *    turn count, which is a separate, pre-existing limitation.
 *
 * FAILS when:
 *      - the timeout fires before turn 3 (one or two calls consumed the
 *        whole 120s budget = incident-class single-call prefill dominance),
 *        or
 *      - any tool result exceeded the 64 KiB cap (the incident's trigger).
 *
 * Skipped automatically unless FASTCONTEXT_API_KEY and FASTCONTEXT_ENDPOINT
 * are set (CI / local runs without an LLM server are unaffected):
 *
 *   FASTCONTEXT_ENDPOINT=http://...:8081/v1 FASTCONTEXT_API_KEY=... \
 *   FASTCONTEXT_MODEL=... npx vitest run tests/integration/timeout-regression.test.ts
 */

import { describe, test, expect } from 'vitest';
import { resolve, join } from "path";
import { tmpdir } from "os";
import { readdirSync, readFileSync, statSync } from "fs";
import { MAX_READ_OUTPUT_BYTES } from "../../src/fastcontext-agent/tools/read.js";

const hasCredentials =
  !!process.env.FASTCONTEXT_API_KEY && !!process.env.FASTCONTEXT_ENDPOINT;

// The incident query, verbatim (it is what produced the 164,028-byte /
// 43,384-token request in the incident capture).
const INCIDENT_PROMPT =
  "Find where the FASTCONTEXT_MODEL environment variable is defined, read, and used. " +
  "Also find how the model is invoked (e.g., via CLI like ollama or other LLM backend), " +
  "and any config files referencing model names like Agents-A1-4B or LFM2.5. " +
  "Report file paths and line numbers.";

/** Largest tool-result content (UTF-8 bytes) recorded in a trajectory file. */
function maxToolResultBytes(trajectoryFile: string): number {
  let max = 0;
  for (const line of readFileSync(trajectoryFile, "utf8").trim().split("\n")) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.role === "tool" && typeof entry.content === "string") {
      max = Math.max(max, Buffer.byteLength(entry.content, "utf8"));
    }
  }
  return max;
}

/** Newest trajectory file in the default temp-dir location. */
function newestTrajectoryFile(): string | null {
  const dir = join(tmpdir(), "pi-fc-search");
  let newest: { file: string; mtime: number } | null = null;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = join(dir, entry);
    const mtime = statSync(file).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { file, mtime };
  }
  return newest?.file ?? null;
}

describe.skipIf(!hasCredentials)(
  "120s timeout regression (2026-08-18 incident, opt-in real server)",
  () => {
    test("no incident-class (huge-read prefill) timeout at the DEFAULT 120s", async () => {
      // Import first (module init runs loadEnvFile once), THEN pin the
      // timeout: executeAgent re-reads the FASTCONTEXT_* configuration per
      // call (D-037), so this value is what the run below uses — the
      // default 120s, not any temporary 600s mitigation in .env/shell.
      const { executeAgent } = await import("../../extensions/index.js");
      process.env.FASTCONTEXT_TIMEOUT_SECONDS = "120";

      let turnsReached = 0;
      try {
        const result = await executeAgent(
          INCIDENT_PROMPT,
          resolve(process.cwd()),
          undefined,
          15,
          false,
          (n) => { turnsReached = n; }
        );

        // --- Tier A: completed within 120s --------------------------------
        expect(typeof result).toBe("string");
        expect(result).toContain("<final_answer>");
        expect(result).not.toContain("[ERROR]");
      } catch (error) {
        if (!(error instanceof Error) || !/timeout exceeded/i.test(error.message)) {
          throw error; // non-timeout failure: always a test failure
        }

        // --- Tier B: timeout, but is it the incident's failure mode? ------
        const trajectory = newestTrajectoryFile();
        expect(
          trajectory,
          "expected a trajectory file in the default temp dir to diagnose the timeout"
        ).not.toBeNull();
        const maxTool = maxToolResultBytes(trajectory!);

        // The incident's trigger: no single tool result may exceed the cap.
        expect(
          maxTool,
          `a ${maxTool}-byte tool result exceeded the ${MAX_READ_OUTPUT_BYTES}-byte ` +
            `Read cap — the incident's huge-read trigger has regressed`
        ).toBeLessThanOrEqual(MAX_READ_OUTPUT_BYTES);

        // Incident class = one or two calls consuming the whole 120s budget
        // (the incident died inside its 2nd call). Reaching turn >= 3 means
        // the budget was spread across turns: model latency/wandering
        // (documented KN-001 class), NOT a huge-read prefill timeout.
        expect(
          turnsReached,
          `timeout after only ${turnsReached} turn(s): one or two LLM calls ` +
            `consumed the entire 120s budget — incident-class prefill ` +
            `dominance has regressed`
        ).toBeGreaterThanOrEqual(3);

        // Passes tier B, but say so loudly: the search itself failed on
        // turn latency, which is a separate pre-existing limitation.
        console.warn(
          `[timeout-regression] search TIMED OUT at 120s after ${turnsReached} turns ` +
          `(largest tool result: ${maxTool} bytes ≤ cap). This is NOT the incident's ` +
          `huge-read prefill failure mode — it is per-turn latency / model wandering ` +
          `(KN-001). Regression property holds.`
        );
      }
    }, 300_000);
  }
);
