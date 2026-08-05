/**
 * GlobTool tests - verify behavioral parity with Python implementation
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { GlobTool } from '../../src/fastcontext-agent/tools/glob.js';
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use a different fixture directory per test suite to avoid race conditions
export const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures_glob__");

function setupTestFixtures(): void {
  fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
  fs.mkdirSync(resolve(TEST_FIXTURES_DIR, "src"), { recursive: true });

  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src/example.ts"), `// This is a test file\nexport function hello() {\n  return "world";\n}\n`, "utf-8");

  // Create many files for glob testing
  for (let i = 0; i < 120; i++) {
    fs.writeFileSync(resolve(TEST_FIXTURES_DIR, `src/test_${i}.ts`), `// Test file ${i}\n`, "utf-8");
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

describe("GlobTool", () => {
  let globTool: GlobTool;

  beforeAll(() => {
    setupTestFixtures();
    globTool = new GlobTool();
  });

  afterAll(() => {
    cleanupTestFixtures();
  });

  test("should find files matching pattern", async () => {
    // Use more specific pattern to avoid hitting 100 limit
    const result = await globTool.call(
      JSON.stringify({
        directory: join(TEST_FIXTURES_DIR, "src"),
        pattern: "**/example.ts"
      }),
      { cwd: TEST_FIXTURES_DIR }
    );

    expect(result).toContain("example.ts");
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
      try {
        fs.rmSync(tempDir, { recursive: true });
      } catch { /* Ignore */ }
    }
  });

  test("should enforce path containment", async () => {
    const outsideDir = resolve(__dirname, "..", "__outside_fixture_glob__");
    fs.mkdirSync(outsideDir);

    try {
      const result = await globTool.call(
        JSON.stringify({
          directory: outsideDir,
          pattern: "*"
        }),
        { cwd: TEST_FIXTURES_DIR }
      );

      expect(result).toContain("Permission error");
    } finally {
      if (fs.existsSync(outsideDir)) {
        fs.rmdirSync(outsideDir);
      }
    }
  });
});
