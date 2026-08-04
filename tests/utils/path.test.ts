/**
 * Path containment tests - verify Windows correctness (SPEC §10)
 */

import { describe, test, expect } from 'vitest';
import { isWithinCwd } from '../../src/fastcontext-agent/utils.js';

describe("Path Containment", () => {
  test("should allow path within cwd", () => {
    const cwd = "/workspace/project";
    const result = isWithinCwd("/workspace/project/src/file.ts", cwd);
    expect(result).toBe(true);
  });

  test("should reject path outside cwd", () => {
    const cwd = "/workspace/project";
    const result = isWithinCwd("/workspace/project2/src/file.ts", cwd);
    expect(result).toBe(false);
  });

  test("should handle relative paths", () => {
    const cwd = "/workspace/project";
    const result = isWithinCwd("src/example.ts", cwd);
    expect(result).toBe(true);
  });

  test("should reject parent directory traversal", () => {
    const cwd = "/workspace/project";
    const result = isWithinCwd("../other/file.ts", cwd);
    expect(result).toBe(false);
  });

  // Windows-specific tests (if running on Windows)
  if (process.platform === "win32") {
    test("should handle Windows drive letters case-insensitively", () => {
      const cwd = "C:\\workspace\\project";
      const candidate1 = "c:\\workspace\\project\\src\\file.ts";
      expect(isWithinCwd(candidate1, cwd)).toBe(true);
      
      const candidate2 = "C:\\workspace\\project2\\src\\file.ts";
      expect(isWithinCwd(candidate2, cwd)).toBe(false);
    });

    test("should handle mixed path separators", () => {
      const cwd = "C:\\workspace\\project";
      const result = isWithinCwd("/workspace/project/src/file.ts", cwd);
      expect(result).toBe(true);
    });
  }
});
