/**
 * ReadTool extended tests - verify all SPEC §8.1 behavioral requirements
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { ReadTool, MAX_FILE_SIZE_BYTES } from '../../src/fastcontext-agent/tools/read.js';
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
});
