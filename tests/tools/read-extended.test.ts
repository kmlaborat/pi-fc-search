/**
 * ReadTool extended tests - verify all SPEC §8.1 behavioral requirements
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { ReadTool, MAX_FILE_SIZE_BYTES, MAX_READ_OUTPUT_BYTES } from '../../src/fastcontext-agent/tools/read.js';
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures_read_extended__");

function setupTestFixtures(): void {
  fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
  fs.mkdirSync(resolve(TEST_FIXTURES_DIR, "src"), { recursive: true });
  fs.mkdirSync(resolve(TEST_FIXTURES_DIR, "test"), { recursive: true });

  // Create file with exactly 2500 lines for truncation testing
  const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}: Content for line ${i + 1}`);
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src/large_file.ts"), lines.join("\n"), "utf-8");

  // Create file with very long lines (>2000 chars)
  const longLine = "X".repeat(2500);
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src/long_line.ts"), `Short line\n${longLine}\nAnother short line\n`, "utf-8");

  // Create a file that exceeds the 64 KiB output budget (D-048, SPEC §18;
  // supersedes the D-025 cap value):
  // 1500 lines x ~190 chars ≈ 285 KB (each line < 2000 chars, file < 10 MB)
  const wideLines = Array.from({ length: 1500 }, (_, i) => `Line ${i + 1}: ${"W".repeat(180)}`);
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src/wide_file.ts"), wideLines.join("\n"), "utf-8");

  // (D-031, SPEC §18) multi-byte fixture: 1500 lines of 3-byte CJK chars
  // (~292 KB of UTF-8 bytes, but only ~108 KB of JS string length) — under
  // byte accounting the 64 KiB budget kicks in; under the old string-length
  // accounting the file would have been returned in full with no note.
  const cjkLines = Array.from({ length: 1500 }, (_, i) => `Line ${i + 1}: ${"あ".repeat(60)}`);
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src/cjk_file.ts"), cjkLines.join("\n"), "utf-8");

  // Create empty file
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "test/empty.txt"), "", "utf-8");

  // Create file with exactly 10 lines for offset testing
  const tenLines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src/ten_lines.ts"), tenLines.join("\n"), "utf-8");
}

function cleanupTestFixtures(): void {
  if (fs.existsSync(TEST_FIXTURES_DIR)) {
    try {
      fs.rmSync(TEST_FIXTURES_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

describe("ReadTool - Extended Tests", () => {
  let readTool: ReadTool;

  beforeAll(() => {
    setupTestFixtures();
    readTool = new ReadTool();
  });

  afterAll(() => {
    cleanupTestFixtures();
  });

  describe("Offset handling", () => {
    test("should handle negative offset", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/ten_lines.ts"),
          offset: -5
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // SPEC §8.1: negative offset is treated as 1 (start from beginning)
      expect(result).toContain("1|");
    });

    test("should handle offset beyond file length", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/ten_lines.ts"),
          offset: 100
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // (Review fix) explicit, actionable message instead of an empty header
      expect(result).toContain("offset 100 exceeds end of file (10 lines)");
    });

    test("should reject non-positive limit", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/ten_lines.ts"),
          offset: 1,
          limit: 0
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // (Review fix) explicit message instead of a silent empty range
      expect(result).toContain("limit must be a positive integer");
    });

    test("should handle offset of 0", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/ten_lines.ts"),
          offset: 0
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // 0 should be treated as 1
      expect(result).toContain("1|");
    });
  });

  describe("Truncation", () => {
    test("should truncate file content at 2000 lines with '...' marker", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/large_file.ts")
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // Should contain truncation marker
      expect(result).toContain("...");

      // Should not exceed 2000 lines of content (plus backticks and marker)
      const contentLines = result.split("\n");
      expect(contentLines.length).toBeLessThanOrEqual(2005);
    });

    test("should truncate long lines at 2000 chars with '...' marker", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/long_line.ts")
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // Should contain line truncation marker
      expect(result).toContain("...");
    });
  });

  describe("Edge cases", () => {
    test("should return 'File is empty.' for empty file", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "test/empty.txt")
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toBe("File is empty.");
    });

    test("should return error for missing file path", async () => {
      const result = await readTool.call(
        JSON.stringify({}),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("file path is required");
    });

    test("should return error for non-existent file", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "nonexistent.ts")
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("does not exist");
    });
  });

  describe("Size and binary guards (D-020, SPEC §18)", () => {
    const OUTSIDE_DIR = resolve(TEST_FIXTURES_DIR, "..", "__test_fixtures_read_outside__");

    test("should reject files larger than MAX_FILE_SIZE_BYTES", async () => {
      const bigPath = join(TEST_FIXTURES_DIR, "src/huge_file.txt");
      fs.writeFileSync(bigPath, Buffer.alloc(MAX_FILE_SIZE_BYTES + 1).fill(65));
      try {
        const result = await readTool.call(
          JSON.stringify({ path: bigPath }),
          { cwd: TEST_FIXTURES_DIR }
        );
        expect(result).toContain("too large");
        expect(result).toContain("Use Grep");
      } finally {
        fs.unlinkSync(bigPath);
      }
    });

    test("should allow a large text file under the size cap", async () => {
      const okPath = join(TEST_FIXTURES_DIR, "src/large_ok.txt");
      fs.writeFileSync(okPath, Buffer.alloc(9 * 1024 * 1024).fill(65));
      try {
        const result = await readTool.call(
          JSON.stringify({ path: okPath, limit: 1 }),
          { cwd: TEST_FIXTURES_DIR }
        );
        expect(result).toContain("```");
        expect(result).not.toContain("too large");
      } finally {
        fs.unlinkSync(okPath);
      }
    });

    test("should reject binary files (NUL bytes within the first 8KB)", async () => {
      const binPath = join(TEST_FIXTURES_DIR, "src/binary.dat");
      fs.writeFileSync(binPath, Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]), // "PK.."
        Buffer.alloc(16).fill(0),
        Buffer.from("tail"),
      ]));
      try {
        const result = await readTool.call(
          JSON.stringify({ path: binPath }),
          { cwd: TEST_FIXTURES_DIR }
        );
        expect(result).toContain("appears to be a binary file");
      } finally {
        fs.unlinkSync(binPath);
      }
    });

    test("should reject a symlink pointing outside the working directory", async () => {
      fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
      const secretPath = join(OUTSIDE_DIR, "secret.txt");
      fs.writeFileSync(secretPath, "top secret\n");
      const linkPath = join(TEST_FIXTURES_DIR, "src/sneaky_link.txt");

      let created = true;
      try {
        fs.symlinkSync(secretPath, linkPath);
      } catch {
        // Platforms that cannot create symlinks without elevation — skip.
        created = false;
      }
      if (!created) {
        fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
        return;
      }

      try {
        const result = await readTool.call(
          JSON.stringify({ path: linkPath }),
          { cwd: TEST_FIXTURES_DIR }
        );
        expect(result).toContain("Permission error");
        expect(result).not.toContain("top secret");
      } finally {
        fs.unlinkSync(linkPath);
        fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
      }
    });
  });

  describe("Output byte budget (D-048, SPEC §18; supersedes D-025)", () => {
    test("should truncate total output at MAX_READ_OUTPUT_BYTES with a continuation note", async () => {
      const result = await readTool.call(
        JSON.stringify({ path: resolve(TEST_FIXTURES_DIR, "src/wide_file.ts") }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain(`output truncated at ${MAX_READ_OUTPUT_BYTES} bytes`);
      expect(result).toContain("re-read with a larger offset and limit");
      // The whole tool result stays comfortably under the fixture's raw size
      expect(result.length).toBeLessThan(300 * 1024);
      // The header must reflect the lines actually shown, not the full range
      const m = /wide_file\.ts:(\d+)-(\d+)/.exec(result);
      expect(m).not.toBeNull();
      expect(Number(m![2])).toBeGreaterThanOrEqual(1);
      expect(Number(m![2])).toBeLessThan(1500);
    });

    test("should continue where the truncated read stopped", async () => {
      const first = await readTool.call(
        JSON.stringify({ path: resolve(TEST_FIXTURES_DIR, "src/wide_file.ts") }),
        { cwd: TEST_FIXTURES_DIR }
      );
      const shownEnd = Number(/wide_file\.ts:\d+-(\d+)/.exec(first)![1]);

      const second = await readTool.call(
        JSON.stringify({
          path: resolve(TEST_FIXTURES_DIR, "src/wide_file.ts"),
          offset: shownEnd + 1,
          limit: 10,
        }),
        { cwd: TEST_FIXTURES_DIR }
      );
      expect(second).toContain(`${shownEnd + 1}|`);
      expect(second).not.toContain("output truncated");
    });

    test("should not truncate small files", async () => {
      const result = await readTool.call(
        JSON.stringify({ path: resolve(TEST_FIXTURES_DIR, "src/ten_lines.ts") }),
        { cwd: TEST_FIXTURES_DIR }
      );
      expect(result).not.toContain("output truncated");
      expect(result).toContain("10|");
    });

    test("should count the budget in UTF-8 bytes, not characters (D-031, SPEC §18)", async () => {
      const result = await readTool.call(
        JSON.stringify({ path: resolve(TEST_FIXTURES_DIR, "src/cjk_file.ts") }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("output truncated");

      // Re-measure the numbered lines exactly as the budget accounts for them:
      // UTF-8 bytes per line + 1 for the newline. The shown lines must fit the
      // budget, and the budget must have been nearly exhausted (the loop stops
      // at the first line that would cross it), which is only true when the
      // 3-byte CJK content is counted as bytes.
      const shown = result.split("\n").filter((l) => /^\d+\|/.test(l));
      const measured = shown.reduce(
        (acc, l) => acc + Buffer.byteLength(l, "utf8") + 1,
        0
      );
      expect(measured).toBeLessThanOrEqual(MAX_READ_OUTPUT_BYTES);
      expect(measured).toBeGreaterThan(MAX_READ_OUTPUT_BYTES - 5000);
      // The old string-length counting would have accumulated only ~108 KB
      // of "budget" for this file and returned it in full with no note —
      // the truncation note above (plus a not-fully-shown file) proves the
      // 3-byte CJK content is now counted as bytes.
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.length).toBeLessThan(1500);
    });
  });

  describe("Paging parameter validation (D-032, SPEC §18)", () => {
    test("should reject a non-integer offset", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/ten_lines.ts"),
          offset: 1.5,
        }),
        { cwd: TEST_FIXTURES_DIR }
      );
      expect(result).toBe("Read Tool: offset must be an integer.");
    });

    test("should reject a non-integer limit", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/ten_lines.ts"),
          limit: 2.5,
        }),
        { cwd: TEST_FIXTURES_DIR }
      );
      expect(result).toBe("Read Tool: limit must be a positive integer.");
    });

    test("should still treat offset < 1 as 1 (preserved §8.1 quirk)", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/ten_lines.ts"),
          offset: -5,
        }),
        { cwd: TEST_FIXTURES_DIR }
      );
      expect(result).toContain("1|");
    });

    test("should still reject limit <= 0", async () => {
      const result = await readTool.call(
        JSON.stringify({
          path: join(TEST_FIXTURES_DIR, "src/ten_lines.ts"),
          limit: 0,
        }),
        { cwd: TEST_FIXTURES_DIR }
      );
      expect(result).toBe("Read Tool: limit must be a positive integer.");
    });
  });
});
