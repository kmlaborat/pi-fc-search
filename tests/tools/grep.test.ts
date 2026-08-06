/**
 * GrepTool tests - verify behavioral parity with Python implementation
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { GrepTool } from '../../src/fastcontext-agent/tools/grep.js';
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use a different fixture directory per test suite to avoid race conditions
export const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures_grep__");

function setupTestFixtures(): void {
  fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
  fs.mkdirSync(resolve(TEST_FIXTURES_DIR, "src"), { recursive: true });

  // Create grep target file
  fs.writeFileSync(join(TEST_FIXTURES_DIR, "grep_target.ts"), `
// This is a test file
export function hello() { return "world"; }
export function greet(name: string) { return \`Hello \${name}\`; }

interface Config {
  enabled: boolean;
  timeout: number;
}
`, "utf-8");

  // Create files in src for multi-file search testing
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

describe("GrepTool", () => {
  let grepTool: GrepTool;

  beforeAll(() => {
    setupTestFixtures();
    grepTool = new GrepTool();
  });

  afterAll(() => {
    cleanupTestFixtures();
  });

  test("should find matches in content mode", async () => {
    const result = await grepTool.call(
      JSON.stringify({
        pattern: "hello",
        path: join(TEST_FIXTURES_DIR, "grep_target.ts"),
        output_mode: "content"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("hello");
  });

  test("should return files with matches", async () => {
    const result = await grepTool.call(
      JSON.stringify({
        pattern: "export function",
        path: join(TEST_FIXTURES_DIR, "grep_target.ts"),
        output_mode: "files_with_matches"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("grep_target.ts");
  });

  test("should count matches", async () => {
    const result = await grepTool.call(
      JSON.stringify({
        pattern: "export",
        path: join(TEST_FIXTURES_DIR, "grep_target.ts"),
        output_mode: "count_matches"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("2"); // Should contain count value
  });

  test("should show context lines", async () => {
    const result = await grepTool.call(
      JSON.stringify({
        pattern: "hello",
        path: join(TEST_FIXTURES_DIR, "grep_target.ts"),
        output_mode: "content",
        "-C": 1
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("test file"); // Context before
  });

  test("should be case insensitive with -i flag", async () => {
    const result = await grepTool.call(
      JSON.stringify({
        pattern: "HELLO",
        path: join(TEST_FIXTURES_DIR, "grep_target.ts"),
        output_mode: "content",
        "-i": true
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("hello"); // Should find lowercase "hello"
  });

  test("should return no matches found", async () => {
    const result = await grepTool.call(
      JSON.stringify({
        pattern: "this_pattern_does_not_exist_xyz123",
        path: join(TEST_FIXTURES_DIR, "grep_target.ts"),
        output_mode: "content"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toBe("No matches found");
  });

  test("should enforce path containment for paths outside cwd", async () => {
    // Use a relative path that escapes through parent directories
    const result = await grepTool.call(
      JSON.stringify({
        pattern: "hello",
        path: "../../../../../../../../../etc/passwd",
        output_mode: "content"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("Permission error");
  });

  test("should add helpful hint for malformed regex patterns", async () => {
    // Use a pattern with a stray closing parenthesis that will cause ripgrep to return a regex parse error
    const result = await grepTool.call(
      JSON.stringify({
        pattern: "(?<=invalid)(?=pattern))",  // trailing ")" causes "regex parse error"
        path: join(TEST_FIXTURES_DIR, "grep_target.ts"),
        output_mode: "content"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    // Should contain the regex error and our helpful hint
    expect(result).toContain("regex parse error");
    expect(result).toContain("[Hint] The regex pattern may be malformed");
  });
});
