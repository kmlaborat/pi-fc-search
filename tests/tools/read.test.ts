/**
 * ReadTool tests - verify behavioral parity with Python implementation
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { ReadTool } from '../../src/fastcontext-agent/tools/read.js';
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use a different fixture directory per test suite to avoid race conditions
export const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures_read__");

function setupTestFixtures(): void {
  fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
  fs.mkdirSync(resolve(TEST_FIXTURES_DIR, "src"), { recursive: true });
  fs.mkdirSync(resolve(TEST_FIXTURES_DIR, "test"), { recursive: true });

  // Create test files with known content for validation
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src/example.ts"), `// This is a test file\nexport function hello() {\n  return "world";\n}\n`, "utf-8");

  // Create file with many lines for truncation testing
  const manyLinesContent = Array.from({ length: 2500 }, (_, i) => 
    `// Line ${i + 1}: This is a long line that should be truncated if it exceeds the MAX_LINE_LENGTH limit of 2000 characters. Some more content here to make this line very long indeed.`
  ).join("\n");
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src/large.ts"), manyLinesContent, "utf-8");

  // Create empty file for testing empty file handling
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "test/empty.txt"), "", "utf-8");
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

describe("ReadTool", () => {
  let readTool: ReadTool;

  beforeAll(() => {
    setupTestFixtures();
    readTool = new ReadTool();
  });

  afterAll(() => {
    cleanupTestFixtures();
  });

  test("should read a normal file", async () => {
    const result = await readTool.call(
      JSON.stringify({ path: join(TEST_FIXTURES_DIR, "src/example.ts") }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("hello()");
    expect(result).toContain("1|"); // Line number prefix
  });

  test("should handle file not found", async () => {
    const result = await readTool.call(
      JSON.stringify({ path: join(TEST_FIXTURES_DIR, "nonexistent.ts") }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("does not exist");
  });

  test("should handle empty file", async () => {
    const result = await readTool.call(
      JSON.stringify({ path: join(TEST_FIXTURES_DIR, "test/empty.txt") }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toBe("File is empty.");
  });

  test("should respect offset and limit parameters", async () => {
    const result = await readTool.call(
      JSON.stringify({
        path: join(TEST_FIXTURES_DIR, "src/large.ts"),
        offset: 50,
        limit: 100
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("50|"); // Should start at line 50
  });

  test("should cap lines to MAX_LINE (2000)", async () => {
    const result = await readTool.call(
      JSON.stringify({ path: join(TEST_FIXTURES_DIR, "src/large.ts") }),
      { cwd: TEST_FIXTURES_DIR }
    );

    // Verify file exists before testing truncation
    expect(result).not.toContain("does not exist");
    expect(result).toContain("..."); // Truncation marker

    const lineCount = result.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(2010); // Include backticks, etc.
  });
});
