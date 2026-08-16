/**
 * Read tool - Docker mount path resolution integration test.
 *
 * Self-contained: builds a temporary workspace whose basename is "test" to
 * mimic the SWE-bench-style "/test/" mount the FastContext models were
 * trained on, then verifies the model-style absolute paths resolve into it.
 * (An earlier revision hard-coded a local machine path here, which broke
 * every non-local CI leg.)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { ReadTool } from '../../src/fastcontext-agent/tools/read.js';
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_ROOT = resolve(__dirname, "..", "__docker_mount_workspace__");
// Basename must be "test" so "/test/sample.js" exercises strategy 2-skip +
// strategy 3 (/test/ prefix strip), exactly like the real Docker mount.
const testCwd = join(WORKSPACE_ROOT, "test");
const readTool = new ReadTool();

beforeAll(() => {
  fs.mkdirSync(join(testCwd, "src"), { recursive: true });
  fs.writeFileSync(join(testCwd, "sample.js"), "// sample module\nexport const sample = true;\n", "utf-8");
  fs.writeFileSync(join(testCwd, "duet.json"), JSON.stringify({ builder: "v1", mode: "test" }, null, 2), "utf-8");
  fs.writeFileSync(join(testCwd, "demo-app.js"), "// demo app entry\nconsole.log('demo');\n", "utf-8");
});

afterAll(() => {
  if (fs.existsSync(WORKSPACE_ROOT)) {
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
});

describe("Read tool - Docker mount path resolution (SWE-bench style /test/ mount)", () => {
  test("should read sample.js via /test/sample.js docker path (the fixed case)", async () => {
    // This is the exact path pattern that failed before the fix: the first
    // component matches the cwd basename, so strategy 2 is skipped and
    // strategy 3 strips the /test/ mount prefix.
    const result = await readTool.call(
      JSON.stringify({ path: "/test/sample.js" }),
      { cwd: testCwd }
    );

    expect(result).not.toContain("does not exist");
    expect(result).not.toContain("IO error");
    expect(result).not.toContain("Permission error");

    // Should contain the correction note showing the mount prefix was stripped
    expect(result).toContain("Path corrected");
    expect(result).toContain("sample.js");
  });

  test("should read duet.json via /duet.json (leading-slash strip still works)", async () => {
    const result = await readTool.call(
      JSON.stringify({ path: "/duet.json" }),
      { cwd: testCwd }
    );

    expect(result).not.toContain("does not exist");
    expect(result).toContain("builder"); // Content check
  });

  test("should read demo-app.js via /test/demo-app.js (same pattern as sample.js)", async () => {
    const result = await readTool.call(
      JSON.stringify({ path: "/test/demo-app.js" }),
      { cwd: testCwd }
    );

    expect(result).not.toContain("does not exist");
    expect(result).toContain("demo-app.js");
  });
});
