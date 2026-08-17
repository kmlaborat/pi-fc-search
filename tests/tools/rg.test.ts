/**
 * Ripgrep path resolution tests (D-028, SPEC §18)
 */

import { describe, test, expect, afterAll } from 'vitest';
import { getRgPath } from '../../src/fastcontext-agent/tools/rg.js';

describe("getRgPath failure handling (D-028, SPEC §18)", () => {
  const savedRipgrepPath = process.env.RIPGREP_PATH;

  afterAll(() => {
    if (savedRipgrepPath === undefined) {
      delete process.env.RIPGREP_PATH;
    } else {
      process.env.RIPGREP_PATH = savedRipgrepPath;
    }
  });

  test("a failed resolution is not cached: a fixed RIPGREP_PATH works on the next call", async () => {
    // First call: stale env value → failure
    process.env.RIPGREP_PATH = "/nonexistent/pi-fc-search-test-rg";
    await expect(getRgPath()).rejects.toThrow(/RIPGREP_PATH/);

    // Second call: env fixed → resolution must succeed. If the failure had
    // been cached (pre-D-028), the stale error would be replayed here.
    delete process.env.RIPGREP_PATH;
    await expect(getRgPath()).resolves.toBeTypeOf("string");
  });

  test("a successful resolution is cached", async () => {
    const first = await getRgPath();
    const second = await getRgPath();
    expect(second).toBe(first);
  });
});
