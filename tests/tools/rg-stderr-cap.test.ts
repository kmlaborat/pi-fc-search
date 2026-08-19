/**
 * runRipgrep stderr error-message cap (D-053, SPEC §18)
 *
 * A failed rg invocation rejects with the accumulated stderr as the error
 * message, which becomes the failed tool result's text. The message must be
 * bounded (8 KiB) — the 16 MB accumulation cap (D-034/D-038) is only a
 * memory bound, and the D-047 tool-result budget (64 KiB) would stub any
 * oversized result before the next LLM call anyway, so surfacing megabytes
 * of stderr as an error message serves no reader.
 */

import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runRipgrep, stderrErrorText } from '../../src/fastcontext-agent/tools/rg.js';

const ERROR_CAP_BYTES = 8 * 1024;

describe("stderrErrorText (D-053, SPEC §18)", () => {
  test("short stderr passes through unchanged", () => {
    const stderr = "regex parse error: nothing here\n";
    expect(stderrErrorText(stderr, 2)).toBe(stderr);
  });

  test("empty stderr falls back to the exit-code message", () => {
    expect(stderrErrorText("", 3)).toBe("Ripgrep exited with code 3");
    expect(stderrErrorText("", null)).toBe("Ripgrep exited with code null");
  });

  test("oversized stderr is truncated at the byte cap with a note", () => {
    const stderr = "x".repeat(ERROR_CAP_BYTES + 1024);
    const result = stderrErrorText(stderr, 2);
    // The cap holds in real UTF-8 bytes (note included).
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      ERROR_CAP_BYTES + 64 // headroom for the trailing note
    );
    expect(result.endsWith(`[stderr truncated at ${ERROR_CAP_BYTES} bytes]`)).toBe(true);
    // The prefix is the first cap-worth of the original.
    expect(result.startsWith("x".repeat(ERROR_CAP_BYTES - 16))).toBe(true);
  });

  test("truncation is UTF-8 safe: a code point split at the byte cut is dropped, not left as U+FFFD", () => {
    // CJK fill: 3 bytes/char. Pad so the 8192-byte cut lands in the
    // middle of a code point (8192 % 3 !== 0).
    const stderr = "あ".repeat(Math.ceil((ERROR_CAP_BYTES + 1024) / 3));
    const result = stderrErrorText(stderr, 2);
    expect(result).not.toContain("\uFFFD");
    const note = `[stderr truncated at ${ERROR_CAP_BYTES} bytes]`;
    expect(result.endsWith(note)).toBe(true);
    // body = everything before the trailing "\n[note]"
    const body = result.slice(0, result.length - note.length - 1);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(ERROR_CAP_BYTES);
  });
});

describe("runRipgrep failure message (D-053, SPEC §18)", () => {
  test("a failed rg run rejects with the (capped) stderr as the message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fc-search-rg-stderr-"));
    try {
      // Invalid regex → exit code 2 with a short "regex parse error" on
      // stderr: under the cap, so it passes through unmodified.
      await expect(runRipgrep(["[unclosed", dir], dir, 10)).rejects.toThrow(
        /regex parse error/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
