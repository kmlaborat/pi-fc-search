/**
 * runRipgrep stdout accumulation cap (D-034, SPEC §18)
 *
 * A single pathological match line (a 20 MB one-liner, as produced by
 * minified bundles or log files) must not be accumulated unbounded: the
 * stdout cap drops chunks beyond 16 MB, so the resolved string is the
 * capped prefix — not the full multi-MB line.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runRipgrep } from '../../src/fastcontext-agent/tools/rg.js';

const CAP_BYTES = 16 * 1024 * 1024;

describe("runRipgrep stdout cap (D-034, SPEC §18)", () => {
  let dir: string;

  afterAll(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("output larger than the cap is truncated to the capped prefix", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-fc-search-rg-cap-"));

    // A single ~20 MB line containing the probe token several times.
    // rg -n emits "<lineno>:<line>" → ~20 MB of stdout, far above the cap.
    const filler = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars
    const repeats = Math.ceil(20 * 1000 * 1000 / (filler.length + 11));
    const line =
      "NEEDLE_START " +
      Array.from({ length: repeats }, () => filler + " NEEDLE_MID ").join("") +
      "NEEDLE_END";
    writeFileSync(join(dir, "big.log"), line + "\n", "utf-8");

    const output = await runRipgrep(["-n", "NEEDLE_MID", join(dir, "big.log")], dir, 30);

    // The search succeeded ...
    expect(output.length).toBeGreaterThan(0);
    // ... but the accumulated string is the capped prefix (~16 MB), not the
    // full ~20 MB line. +64 tolerates one final partial chunk and the
    // line-number prefix; the uncapped string would exceed this by ~4 MB.
    expect(output.length).toBeLessThanOrEqual(CAP_BYTES + 64);
    // The cap cut the line mid-content: the tail marker never made it
    // through.
    expect(output.includes("NEEDLE_END")).toBe(false);
  }, 60_000);
});
