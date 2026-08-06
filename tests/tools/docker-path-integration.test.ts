import { describe, test, expect } from 'vitest';
import { ReadTool } from '../../src/fastcontext-agent/tools/read.js';

describe("Read tool - Docker mount path resolution for real workspace", () => {
  // Test with actual test workspace files
  const testCwd = "C:\\Users\\Game\\MyDevEnv\\wd\\test";
  const readTool = new ReadTool();

  test("should read sample.js via /test/sample.js docker path (the fixed case)", async () => {
    // This is the exact path pattern that failed before the fix
    const result = await readTool.call(
      JSON.stringify({ path: "/test/sample.js" }),
      { cwd: testCwd }
    );
    
    console.log("Result for /test/sample.js:", result);
    
    // Should NOT contain error message
    expect(result).not.toContain("does not exist");
    expect(result).not.toContain("IO error");
    expect(result).not.toContain("Permission error");
    
    // Should contain the correction note showing Strategy 3 was used
    expect(result).toContain("Path corrected");
    expect(result).toContain("sample.js");
  });

  test("should read duet.json via /duet.json (original working case still works)", async () => {
    const result = await readTool.call(
      JSON.stringify({ path: "/duet.json" }),
      { cwd: testCwd }
    );
    
    console.log("Result for /duet.json:", result);
    
    expect(result).not.toContain("does not exist");
    expect(result).toContain("builder"); // Content check
  });

  test("should read demo-app.js via /test/demo-app.js (same pattern as sample.js)", async () => {
    const result = await readTool.call(
      JSON.stringify({ path: "/test/demo-app.js" }),
      { cwd: testCwd }
    );
    
    console.log("Result for /test/demo-app.js:", result);
    
    expect(result).not.toContain("does not exist");
  });
});
