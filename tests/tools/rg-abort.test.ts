/**
 * Ripgrep abort-signal tests (D-050, SPEC §18)
 *
 * The agent's abort signal (user cancellation / total-execution timeout) is
 * forwarded through ToolSet → tools → runRipgrep. These tests verify that
 * rg is stopped immediately on abort instead of running out its own 10s
 * per-call timeout.
 */

import { describe, test, expect } from 'vitest';
import { resolve } from 'path';
import { runRipgrep, getRgPath } from '../../src/fastcontext-agent/tools/rg.js';

// A directory whose full scan demonstrably takes much longer than the
// abort delay below (measured ~14s for this repo's node_modules; the
// pattern never matches, so rg scans every file).
const SLOW_DIR = resolve(process.cwd(), "node_modules");

describe("runRipgrep abort signal (D-050, SPEC §18)", () => {
  test("rejects immediately when the signal is already aborted", async () => {
    await getRgPath(); // resolution errors surface as their own failure
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    const started = Date.now();
    await expect(
      runRipgrep(["zz_never_match_zz", SLOW_DIR], process.cwd(), 10, controller.signal)
    ).rejects.toBe(reason);
    // Pre-aborted: no spawn, no timeout wait.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("kills a running rg on abort (rejects with the signal reason, not the timeout)", async () => {
    await getRgPath();
    const controller = new AbortController();
    const reason = new Error("cancelled");

    const started = Date.now();
    const promise = runRipgrep(
      // Full-tree scan of node_modules takes ~14s (no matches) — far
      // beyond both the abort delay and the 10s tool timeout.
      ["-g", "**", "zz_never_match_zz", SLOW_DIR],
      process.cwd(),
      10,
      controller.signal
    );
    // Give rg time to start scanning, then cancel the search.
    setTimeout(() => controller.abort(reason), 100);

    await expect(promise).rejects.toBe(reason);
    // The abort must settle the promise promptly — not at the 10s timeout.
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20000);

  test("no signal: behavior unchanged (resolves with stdout)", async () => {
    await getRgPath();
    // Target a single stable file (not a directory walk): other test files
    // create/remove fixture directories under tests/ in parallel, and a
    // concurrent walk of "." can race a vanished directory (rg exit 2).
    // rg omits the file-name header for a single-file path, so assert on
    // the matched line itself.
    const out = await runRipgrep(
      ["shell: false", "src/fastcontext-agent/tools/rg.ts"],
      process.cwd(),
      10
    );
    expect(out).toContain("shell: false");
  });
});

describe("ToolSet forwards the abort signal to tools (D-050, SPEC §18)", () => {
  test("callNormalized passes the signal into the tool CallContext", async () => {
    const { ToolSet } = await import("../../src/fastcontext-agent/tools/types.js");

    const seenSignals: (AbortSignal | undefined)[] = [];
    const fakeTool = {
      name: "Probe",
      description: "records the call context",
      parameters: { type: "object", properties: {} },
      schema: () => ({ type: "function", function: { name: "Probe", description: "", parameters: {} } }),
      async call(_params: string, ctx: { cwd: string; signal?: AbortSignal }): Promise<string> {
        seenSignals.push(ctx.signal);
        return "ok";
      },
    };

    const controller = new AbortController();
    const toolset = new ToolSet([fakeTool as any], process.cwd());
    const results = await toolset.callNormalized(
      [{ id: "call_1", name: "Probe", arguments: {} }],
      controller.signal
    );
    expect(results[0].failed).toBe(false);
    expect(seenSignals).toEqual([controller.signal]);
  });
});
