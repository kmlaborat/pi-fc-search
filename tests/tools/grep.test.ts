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

  test("should truncate output lines longer than 2000 characters (D-024, SPEC §18)", async () => {
    const file = join(TEST_FIXTURES_DIR, "minified.js");
    fs.writeFileSync(file, `var x = ${"A".repeat(5000)};\n`, "utf-8");

    const result = await grepTool.call(
      JSON.stringify({
        pattern: "var x",
        path: file,
        output_mode: "content"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    // The 5000-char match line must not survive verbatim
    expect(result).not.toContain("A".repeat(2001));
    expect(result).toContain("...");
    // Every returned line is bounded by the 2000-char cap + "..."
    for (const line of result.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(2003);
    }
  });

  // (D-035, SPEC §18) -C is a fallback default: explicit -A/-B define the
  // context precisely and suppress the default -C 3 (rg applies the later
  // context flag per direction, so pushing the default -C after -B/-A used
  // to silently override them).
  const writeCtxFixture = () => {
    const file = join(TEST_FIXTURES_DIR, "ctx_fixture.txt");
    fs.writeFileSync(
      file,
      ["line1", "line2", "line3", "MATCH", "line5", "line6", "line7", "line8", "line9"].join("\n") + "\n",
      "utf-8"
    );
    return file;
  };

  test("applies the default -C 3 context when no -A/-B is given (D-035, SPEC §18)", async () => {
    const file = writeCtxFixture();
    const result = await grepTool.call(
      JSON.stringify({ pattern: "MATCH", path: file, output_mode: "content" }),
      { cwd: TEST_FIXTURES_DIR }
    );

    // With --heading, context lines are separated by '-' and match lines by ':'.
    expect(result).toContain("1-line1"); // 3 lines before the match
    expect(result).toContain("4:MATCH");
    expect(result).toContain("7-line7"); // 3 lines after the match
    expect(result).not.toContain("8-line8");
  });

  test("honors an explicit -A without the default -C (D-035, SPEC §18)", async () => {
    const file = writeCtxFixture();
    const result = await grepTool.call(
      JSON.stringify({ pattern: "MATCH", path: file, output_mode: "content", "-A": 2 }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("4:MATCH");
    expect(result).toContain("5-line5"); // 2 lines after
    expect(result).toContain("6-line6");
    expect(result).not.toContain("3-line3"); // no context before
    expect(result).not.toContain("7-line7"); // no default -C leak
  });

  test("honors explicit -B and -A precisely (D-035, SPEC §18)", async () => {
    const file = writeCtxFixture();
    const result = await grepTool.call(
      JSON.stringify({ pattern: "MATCH", path: file, output_mode: "content", "-B": 1, "-A": 1 }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("3-line3"); // 1 line before
    expect(result).toContain("4:MATCH");
    expect(result).toContain("5-line5"); // 1 line after
    expect(result).not.toContain("2-line2");
    expect(result).not.toContain("6-line6");
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
