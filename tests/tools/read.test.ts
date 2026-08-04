/**
 * ReadTool tests - verify behavioral parity with Python implementation
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { ReadTool } from '../../src/fastcontext-agent/tools/read.js';
import { join } from "path";
import * as fs from "fs";
import { setupTestFixtures, cleanupTestFixtures, TEST_FIXTURES_DIR } from "../setup.js";

describe("ReadTool", () => {
  let readTool: ReadTool;

  beforeAll(() => {
    readTool = new ReadTool();
    setupTestFixtures();
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
    
    expect(result).toContain("..."); // Truncation marker
    
    const lineCount = result.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(2010); // Include backticks, etc.
  });
});
