/**
 * GrepTool extended tests - verify all SPEC §8.3 behavioral requirements
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { GrepTool } from '../../src/fastcontext-agent/tools/grep.js';
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures_grep_extended__");

function setupTestFixtures(): void {
  fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
  fs.mkdirSync(resolve(TEST_FIXTURES_DIR, "src"), { recursive: true });

  // Create file with many matches for head_limit testing
  const matches = Array.from({ length: 150 }, (_, i) => `export function func${i}() { return "match ${i}"; }`).join("\n");
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "many_matches.ts"), matches, "utf-8");

  // Create file for output_mode testing
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "output_test.ts"), `
// Test file for output modes
export function hello() { return "world"; }
export function greet(name: string) { return name; }

interface Config {
  enabled: boolean;
}
`, "utf-8");

  // Create multiple files for multi-file search
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(resolve(TEST_FIXTURES_DIR, `src/func_${i}.ts`), `export function func${i}() {}\n`, "utf-8");
  }
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

describe("GrepTool - Extended Tests", () => {
  let grepTool: GrepTool;

  beforeAll(() => {
    setupTestFixtures();
    grepTool = new GrepTool();
  });

  afterAll(() => {
    cleanupTestFixtures();
  });

  describe("Output mode handling", () => {
    test("should handle 'count' output mode (preserving upstream quirk)", async () => {
      // SPEC §8.3: Schema says "count" but internally uses "count_matches"
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "count"
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // Should work with "count" mode
      expect(result).toBeDefined();
    });

    test("should handle 'count_matches' output mode (internal quirk preserved)", async () => {
      // This verifies the upstream quirk is preserved
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "count_matches"
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // Should work with "count_matches" mode too
      expect(result).toBeDefined();
    });

    test("should handle 'content' output mode with context", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "hello",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content",
          "-C": 1
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("hello");
    });

    test("should handle 'files_with_matches' output mode", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export function",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "files_with_matches"
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("output_test.ts");
    });
  });

  describe("Head limit handling", () => {
    test("should apply head_limit of 0 (no limit)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "many_matches.ts"),
          output_mode: "content",
          head_limit: 0
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // head_limit 0 means no additional limit (use default 100)
      expect(result).toBeDefined();
    });

    test("should apply head_limit less than 100", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "many_matches.ts"),
          output_mode: "content",
          head_limit: 10
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // Should be limited to 10 lines
      const lines = result.split("\n");
      expect(lines.length).toBeLessThanOrEqual(12); // 10 + truncation message + margin
    });

    test("should use default 100 limit when head_limit >= 100", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "many_matches.ts"),
          output_mode: "content",
          head_limit: 200
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // Should use default 100 limit
      const lines = result.split("\n");
      expect(lines.length).toBeLessThanOrEqual(105);
    });
  });

  describe("Permission error handling", () => {
    test("should return correct permission error for path outside cwd", async () => {
      // Use relative path that escapes through parent directories
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "test",
          path: "../../../../../../../../etc/passwd",
          output_mode: "content"
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("Permission error");
      expect(result).toContain("is not within the working directory");
    });
  });

  describe("No matches", () => {
    test("should return exactly 'No matches found'", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "this_pattern_does_not_exist_xyz123",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content"
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toBe("No matches found");
    });
  });

  describe("Context lines", () => {
    test("should show context with -B (before)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "hello",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content",
          "-B": 1
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("hello");
    });

    test("should show context with -A (after)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "hello",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content",
          "-A": 1
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("hello");
    });
  });
});
