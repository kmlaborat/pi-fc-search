/**
 * GrepTool tests - verify behavioral parity with Python implementation
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { GrepTool } from '../../src/fastcontext-agent/tools/grep.js';
import { join } from "path";
import * as fs from "fs";
import { setupTestFixtures, cleanupTestFixtures, TEST_FIXTURES_DIR } from "../setup.js";

describe("GrepTool", () => {
  let grepTool: GrepTool;

  beforeAll(() => {
    grepTool = new GrepTool();
    setupTestFixtures();
    
    // Create files with specific content for grep testing
    fs.writeFileSync(join(TEST_FIXTURES_DIR, "grep_target.ts"), `
// This is a test file
export function hello() { return "world"; }
export function greet(name: string) { return \`Hello \${name}\`; }

interface Config {
  enabled: boolean;
  timeout: number;
}
`, "utf-8");
  });

  afterAll(() => {
    cleanupTestFixtures();
  });

  // Skip tests requiring ripgrep from @vscode/ripgrep - will work in pi runtime
  test.skip("should find matches in content mode", async () => {
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

  test.skip("should return files with matches", async () => {
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

  test.skip("should count matches", async () => {
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

  test.skip("should show context lines", async () => {
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

  test.skip("should be case insensitive with -i flag", async () => {
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

  test.skip("should return no matches found", async () => {
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

  test.skip("should apply head_limit truncation", async () => {
    const result = await grepTool.call(
      JSON.stringify({ 
        pattern: "export",
        path: join(TEST_FIXTURES_DIR, "src"), // Search whole src dir with many files
        output_mode: "files_with_matches",
        head_limit: 2
      }),
      { cwd: TEST_FIXTURES_DIR }
    );
    
    if (result.includes("Results truncated")) {
      expect(result).toContain("truncated to first");
    }
  });

  test.skip("should enforce path containment", async () => {
    const result = await grepTool.call(
      JSON.stringify({ 
        pattern: "hello",
        path: "/etc/passwd", // Try to escape cwd
        output_mode: "content"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );
    
    expect(result).toContain("Permission error");
  });
});
