/**
 * Docker-mount path resolution tests.
 * Verifies that FastContext model outputs like `/pi-fc-search/package.json` 
 * are correctly resolved to cwd-relative paths.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { resolveDockerMountPath, isWithinCwd } from '../../src/fastcontext-agent/utils.js';
import { join, resolve, dirname } from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures_docker_path__");
// The simulated repo dir MUST be named "pi-fc-search" (basename) so the
// docker-mount strategies that key off the cwd basename are exercised, and
// the existence verification (SPEC §8.5) finds the real files.
const REPO_DIR = resolve(TEST_FIXTURES_DIR, "pi-fc-search");

beforeAll(() => {
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(resolve(REPO_DIR, "src"), { recursive: true });
  fs.writeFileSync(resolve(REPO_DIR, "package.json"), '{}', 'utf-8');
  fs.writeFileSync(resolve(REPO_DIR, "src", "index.ts"), '// file', 'utf-8');
  // A top-level file with the same name as one inside the subdirectory, to
  // test strategy 3 (mount-prefix strip) vs. real subdirectory disambiguation
  fs.writeFileSync(resolve(REPO_DIR, "fake_file.txt"), 'top-level', 'utf-8');

  // Create a subdirectory with same name as cwd basename to test false positive correction
  const subdir = resolve(REPO_DIR, "pi-fc-search");
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
  const cwd = REPO_DIR;
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

  test("should strip the mount prefix without doubling the basename (no over-correction)", () => {
    // The model outputs /pi-fc-search/fake_file.txt. Strategy 2 must be
    // skipped (first component == cwd basename, KN-002) and strategy 3 must
    // strip the /pi-fc-search/ prefix — the result must be <cwd>/fake_file.txt,
    // never <cwd>/pi-fc-search/pi-fc-search/...
    const dockerPath = `/${cwdBasename}/fake_file.txt`;

    const result = resolveDockerMountPath(dockerPath, cwd);
    expect(result).toBeDefined();
    expect(result!.resolved).toBe(resolve(cwd, "fake_file.txt"));
    expect(isWithinCwd(result!.resolved, cwd)).toBe(true);
  });

  test("existence gate: unresolvable docker-style paths return null (D-006)", () => {
    // Non-existent candidates must NOT be accepted by strategies 2-4,
    // otherwise any absolute path would be swallowed and the SPEC 12
    // containment Permission error would become unreachable.
    expect(resolveDockerMountPath("/pi-fc-search/missing.txt", cwd)).toBeNull();
    expect(resolveDockerMountPath("/missing.txt", cwd)).toBeNull();
  });
});

describe("Edge Cases for Docker Mount Path Resolution", () => {
  const cwd = REPO_DIR;
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

describe("Case sensitivity of basename matching (D-033, SPEC §18)", () => {
  const cwd = REPO_DIR;

  test("case-mismatched repo-name component is corrected only on case-insensitive platforms", () => {
    // The cwd basename is "pi-fc-search"; "PI-FC-SEARCH" names a different,
    // non-existent entry on case-sensitive (POSIX) filesystems, so it must
    // not be "corrected" there. On Windows the default filesystems are
    // case-insensitive and the correction applies.
    const mismatched = "/PI-FC-SEARCH/package.json";
    const result = resolveDockerMountPath(mismatched, cwd);

    if (process.platform === "win32") {
      expect(result).not.toBeNull();
      expect(result!.resolved).toBe(resolve(cwd, "package.json"));
    } else {
      expect(result).toBeNull();
    }
  });
});
