/**
 * GlobTool tests - verify behavioral parity with Python implementation
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { GlobTool } from '../../src/fastcontext-agent/tools/glob.js';
import { join } from "path";
import * as fs from "fs";
import { setupTestFixtures, cleanupTestFixtures, TEST_FIXTURES_DIR } from "../setup.js";

describe("GlobTool", () => {
  let globTool: GlobTool;

  beforeAll(() => {
    globTool = new GlobTool();
    setupTestFixtures();
  });

  afterAll(() => {
    cleanupTestFixtures();
  });

  test("should find files matching pattern", async () => {
    const result = await globTool.call(
      JSON.stringify({ 
        directory: join(TEST_FIXTURES_DIR, "src"),
        pattern: "**/*.ts" 
      }),
      { cwd: TEST_FIXTURES_DIR }
    );
    
    expect(result).toContain("example.ts");
    expect(result).not.toContain("Results are truncated");
  });

  test("should return no files found", async () => {
    const result = await globTool.call(
      JSON.stringify({ 
        directory: join(TEST_FIXTURES_DIR, "src"),
        pattern: "**/nonexistent_*" 
      }),
      { cwd: TEST_FIXTURES_DIR }
    );
    
    expect(result).toBe("No files found");
  });

  test("should handle non-existent directory", async () => {
    const result = await globTool.call(
      JSON.stringify({ 
        directory: join(TEST_FIXTURES_DIR, "nonexistent"),
        pattern: "**/*.ts" 
      }),
      { cwd: TEST_FIXTURES_DIR }
    );
    
    expect(result).toContain("does not exist");
  });

  test("should truncate results to 100 matches", async () => {
    // Create many files in a subdirectory
    const tempDir = join(TEST_FIXTURES_DIR, "many_files");
    fs.mkdirSync(tempDir);
    
    for (let i = 0; i < 150; i++) {
      fs.writeFileSync(join(tempDir, `file_${i}.ts`), "// test\n", "utf-8");
    }

    try {
      const result = await globTool.call(
        JSON.stringify({ 
          directory: tempDir,
          pattern: "**/*.ts" 
        }),
        { cwd: TEST_FIXTURES_DIR }
      );
      
      expect(result).toContain("Results are truncated");
      expect(result).toContain("first 100 results");
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  test("should enforce path containment", async () => {
    const result = await globTool.call(
      JSON.stringify({ 
        directory: "/tmp/../etc", // Try to escape cwd
        pattern: "**/*" 
      }),
      { cwd: TEST_FIXTURES_DIR }
    );
    
    expect(result).toContain("Permission error");
  });
});
