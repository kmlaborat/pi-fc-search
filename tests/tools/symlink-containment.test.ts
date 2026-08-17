/**
 * Symlink containment tests (D-022, SPEC §18) - Glob and Grep must not
 * list/search files outside the working directory through a symlink that
 * lives inside it (same defense the Read tool has had since D-020).
 *
 * Symlink creation is not always available (Windows without the
 * CreateSymbolicLink privilege, restricted CI runners), so the escape
 * tests skip when the fixture could not be built.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, test, expect, afterAll } from "vitest";
import { GlobTool } from "../../src/fastcontext-agent/tools/glob.js";
import { GrepTool } from "../../src/fastcontext-agent/tools/grep.js";

const base = mkdtempSync(join(tmpdir(), "pi-fc-symlink-"));
const outside = join(base, "outside");
const cwd = join(base, "work");

mkdirSync(outside);
mkdirSync(cwd);
writeFileSync(join(outside, "secret.ts"), "export const SECRET = 42;\n");
writeFileSync(join(cwd, "local.ts"), "export const LOCAL = 1;\n");

let symlinksOk = false;
try {
  // A junction works on Windows NTFS without elevated privileges.
  symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
  symlinksOk = true;
} catch {
  symlinksOk = false;
}

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("Symlink containment (D-022, SPEC §18)", () => {
  test.skipIf(!symlinksOk)("Glob rejects a symlinked directory pointing outside cwd", async () => {
    const result = await new GlobTool().call(
      JSON.stringify({ directory: join(cwd, "link"), pattern: "**/*.ts" }),
      { cwd }
    );
    expect(result).toContain("Permission error");
    expect(result).toContain("resolves to");
    expect(result).not.toContain("secret.ts");
  });

  test.skipIf(!symlinksOk)("Grep rejects a symlinked path pointing outside cwd", async () => {
    const result = await new GrepTool().call(
      JSON.stringify({ pattern: "SECRET", path: join(cwd, "link") }),
      { cwd }
    );
    expect(result).toContain("Permission error");
    expect(result).not.toContain("SECRET = 42");
  });

  test("Glob still works for a regular (non-symlink) directory", async () => {
    const result = await new GlobTool().call(
      JSON.stringify({ directory: cwd, pattern: "**/local.ts" }),
      { cwd }
    );
    expect(result).toContain("local.ts");
    expect(result).not.toContain("Permission error");
  });

  test("Grep still works for a regular (non-symlink) path", async () => {
    const result = await new GrepTool().call(
      JSON.stringify({ pattern: "LOCAL", path: cwd }),
      { cwd }
    );
    expect(result).toContain("LOCAL = 1");
    expect(result).not.toContain("Permission error");
  });
});
