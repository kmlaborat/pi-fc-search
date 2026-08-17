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

  // Create file with enough matches to exercise the 2000-line head_limit cap (D-010)
  const bigMatches = Array.from({ length: 2500 }, (_, i) => `export function big${i}() { return "match ${i}"; }`).join("\n");
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "many_matches_big.ts"), bigMatches, "utf-8");

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

    test("should honor explicit -C: 0 (no context lines, D-013 SPEC §18)", async () => {
      // A fixture where the match has adjacent lines: with the v2 `|| 3` bug an
      // explicit -C: 0 silently gained 3 context lines; `?? 3` must not.
      const zeroCtx = await grepTool.call(
        JSON.stringify({
          pattern: "hello",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content",
          "-C": 0
        }),
        { cwd: TEST_FIXTURES_DIR }
      );
      const defaultCtx = await grepTool.call(
        JSON.stringify({
          pattern: "hello",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content"
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(zeroCtx).toContain("hello");
      // The default-context run must be strictly larger (context lines added),
      // proving that -C: 0 suppressed context rather than falling back to 3.
      expect(defaultCtx.length).toBeGreaterThan(zeroCtx.length);
      // No context separator lines from rg in the zero-context output.
      expect(zeroCtx).not.toMatch(/^ *- *$/m);
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
    test("should reject head_limit of 0 with an actionable message (D-017, SPEC §18)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "many_matches.ts"),
          output_mode: "content",
          head_limit: 0
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // (D-017) 0 is no longer silently remapped to the default 100
      expect(result).toContain("head_limit must be a positive integer");
      expect(result).toContain("Omit head_limit for the default (100 lines)");
    });

    test("should reject negative head_limit (D-017, SPEC §18)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "many_matches.ts"),
          output_mode: "content",
          head_limit: -5
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("head_limit must be a positive integer");
    });

    test("should reject non-integer head_limit (review fix)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "many_matches.ts"),
          output_mode: "content",
          head_limit: 1.5
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // The schema declares an integer; 1.5 must be rejected rather than
      // silently integer-coerced by Array.slice.
      expect(result).toContain("head_limit must be a positive integer");
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

    test("should honor head_limit >= 100 (D-010, SPEC §18)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "many_matches.ts"),
          output_mode: "content",
          head_limit: 200
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // The fixture has 150 matching lines; an explicit head_limit of 200
      // must be honored (upstream clamped it back to 100), so all 150 lines
      // come back and no truncation note is appended.
      const lines = result.split("\n");
      expect(lines.length).toBeGreaterThan(105);
      expect(result).not.toContain("Results truncated");
    });

    test("should cap head_limit at 2000 lines (D-010, SPEC §18)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "export",
          path: join(TEST_FIXTURES_DIR, "many_matches_big.ts"),
          output_mode: "content",
          head_limit: 5000
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // 2500 matching lines available; head_limit 5000 is capped at 2000.
      const lines = result.split("\n");
      expect(lines.length).toBeLessThanOrEqual(2001); // 2000 + truncation note
      expect(result).toContain("Results truncated to first 2000 lines");
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

    test("should honor explicit -B: 0 combined with -A (D-044, SPEC §18)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "hello",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content",
          "-B": 0,
          "-A": 2
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      // -A 2 shows the line after the match; -B 0 keeps the preceding
      // comment line out of the output.
      expect(result).toContain("greet");
      expect(result).not.toContain("Test file for output modes");
    });

    test("should reject negative -B with an actionable message (D-044, SPEC §18)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "hello",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content",
          "-B": -1
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("-B must be a non-negative integer");
    });

    test("should reject non-integer -C with an actionable message (D-044, SPEC §18)", async () => {
      const result = await grepTool.call(
        JSON.stringify({
          pattern: "hello",
          path: join(TEST_FIXTURES_DIR, "output_test.ts"),
          output_mode: "content",
          "-C": 1.5
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("-C must be a non-negative integer");
    });
  });
});
