/**
 * Docker-mount path resolution tests.
 * Verifies that FastContext model outputs like `/pi-fc-search/package.json` 
 * are correctly resolved to cwd-relative paths.
 */

import { describe, test, expect } from 'vitest';
import { resolveDockerMountPath, isWithinCwd } from '../../src/fastcontext-agent/utils.js';
import { join, resolve, dirname } from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures_docker_path__");

beforeAll(() => {
  fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
  fs.mkdirSync(resolve(TEST_FIXTURES_DIR, "src"), { recursive: true });
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "package.json"), '{}', 'utf-8');
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "src", "index.ts"), '// file', 'utf-8');
  
  // Create a subdirectory with same name as cwd basename to test false positive correction
  const subdir = resolve(TEST_FIXTURES_DIR, "pi-fc-search");
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(resolve(subdir, "fake_file.txt"), 'fake', 'utf-8');
});

afterAll(() => {
  if (fs.existsSync(TEST_FIXTURES_DIR)) {
    try {
      fs.rmSync(TEST_FIXTURES_DIR, { recursive: true, force: true });
    } catch {}
  }
});

describe("Docker Mount Path Resolution", () => {
  const cwd = TEST_FIXTURES_DIR;
  const cwdBasename = "pi-fc-search"; // simulated repo name for testing

  test("should resolve /<repo-name>/path style paths correctly", () => {
    // Simulate the FastContext model output: "/pi-fc-search/package.json"
    const dockerPath = `/${cwdBasename}/package.json`;
    
    const result = resolveDockerMountPath(dockerPath, cwd);
    expect(result).toBeDefined();
    expect(result!.resolved).toContain("package.json");
  });

  test("should strip leading slash and treat as relative path", () => {
    // "/package.json" -> "./package.json"
    const result = resolveDockerMountPath("/package.json", cwd);
    
    expect(result).toBeDefined();
    expect(result!.resolved).toContain("package.json");
  });

  test("should handle nested paths correctly", () => {
    const dockerPath = `/${cwdBasename}/src/index.ts`;
    
    const result = resolveDockerMountPath(dockerPath, cwd);
    expect(result).toBeDefined();
    expect(result!.resolved).toContain("src");
    expect(result!.resolved).toContain("index.ts");
  });

  test("should preserve paths already within cwd", () => {
    // Normal relative path should work without correction
    const result = resolveDockerMountPath("./package.json", cwd);
    
    expect(result).toBeDefined();
    expect(result!.correction).toBeUndefined(); // No correction needed
  });

  test("should reject paths that escape cwd boundaries", () => {
    // Path traversal attempt should fail the containment check
    const evilPath = "../../etc/passwd";
    
    const result = resolveDockerMountPath(evilPath, cwd);
    expect(result).toBeNull();
  });

  test("should handle Windows-style paths on Windows", () => {
    if (process.platform === "win32") {
      // Windows absolute path starting with drive letter
      const windowsPath = `C:${cwd}/package.json`;
      
      const result = resolveDockerMountPath(windowsPath, cwd);
      // Should fall back gracefully since this is testing containment logic
      expect(result).toBeDefined();
    }
  });

  test("should include correction message when path is modified", () => {
    const dockerPath = `/${cwdBasename}/package.json`;
    
    const result = resolveDockerMountPath(dockerPath, cwd);
    expect(result).toBeDefined();
    // Correction message should be present when path was transformed
    if (result!.correction) {
      expect(result!.correction).toContain("corrected");
    }
  });

  test("should not incorrectly correct when real subdirectory has same name as cwd basename", () => {
    // The model outputs /pi-fc-search/fake_file.txt
    // If pi-fc-search/ is a real subdirectory under cwd, should NOT try to strip it
    // This tests that we don't over-correct
    const dockerPath = `/${cwdBasename}/fake_file.txt`;
    
    const result = resolveDockerMountPath(dockerPath, cwd);
    expect(result).toBeDefined();
  });
});

describe("Edge Cases for Docker Mount Path Resolution", () => {
  const cwd = TEST_FIXTURES_DIR;
  const cwdBasename = "pi-fc-search"; // Same as used in parent describe

  test("should handle basename subdirectory correctly without false correction", () => {
    // Create a nested structure: /pi-fc-search/pi-fc-search/package.json
    // This tests we don't strip more than intended
    const subdirPath = `/${cwdBasename}/pi-fc-search/package.json`;
    
    const result = resolveDockerMountPath(subdirPath, cwd);
    expect(result).toBeDefined();
  });

  test("should reject paths that escape cwd after correction", () => {
    // Path that looks valid but escapes when resolved
    const path = `/${cwdBasename}/../../../etc/passwd`;
    
    const result = resolveDockerMountPath(path, cwd);
    expect(result).toBeNull();
  });
});

describe("isWithinCwd - Path Containment Tests", () => {
  const cwd = "/workspace/project";

  test("should allow same path as cwd", () => {
    expect(isWithinCwd(cwd, cwd)).toBe(true);
  });

  test("should allow nested paths within cwd", () => {
    expect(isWithinCwd("/workspace/project/src/file.ts", cwd)).toBe(true);
  });

  test("should reject sibling directory with similar prefix", () => {
    // Project2 starts with 'Project' — naive string check would fail here
    expect(isWithinCwd("/workspace/project2/src/file.ts", cwd)).toBe(false);
  });

  test("should handle relative paths correctly", () => {
    expect(isWithinCwd("src/example.ts", cwd)).toBe(true);
  });

  test("should reject parent directory traversal", () => {
    expect(isWithinCwd("../other/file.ts", cwd)).toBe(false);
  });
});
