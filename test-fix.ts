import { resolveDockerMountPath, isWithinCwd } from "./src/fastcontext-agent/utils.js";
import * as path from "node:path";

const testCases = [
  // [inputPath, expectedBehavior]
  ["duet.json", "success-strategy2"],     // leading slashなし
  ["/duet.json", "success-strategy2"],    // leading slashあり、basename一致せず
  ["/test/sample.js", "success-strategy3"],  // leading slash+dirname一致 → Strategy 3へskip
  ["/test/src/main.ts", "success-strategy3"],  // same pattern
  ["/pi-fc-search/package.json", "success-strategy3"],  // pi-fc-search cwdの場合
  ["./src/utils.ts", "success-strategy1"],  // relative path
];

console.log("=== Test: resolveDockerMountPath fixes ===\n");

// Test with cwd=test directory
const cwd_test = "C:\\Users\\Game\\MyDevEnv\\wd\\test";
console.log(`Testing with cwd: ${cwd_test}\n`);

for (const [inputPath, expected] of testCases) {
  const result = resolveDockerMountPath(inputPath, cwd_test);
  const status = result ? "✓ SUCCESS" : "✗ FAILED";
  
  if (result && expected.startsWith("success-")) {
    const successStrategies = ["strategy1", "strategy2", "strategy3"];
    // Determine which strategy was used based on correction message
    let actualStrategy = "strategy1"; // direct
    if (result.correction?.includes("/duet.json") && !result.correction.includes("pi-fc-search")) {
      actualStrategy = "strategy2";
    } else if (result.correction?.includes("sample.js")) {
      actualStrategy = "strategy3";
    }
    
    console.log(`Input: ${inputPath}`);
    console.log(`Expected: ${expected} -> Actual: success-${actualStrategy}`);
    console.log(`Result: ${result.resolved.replace(/\\{2,}/g, "\\")}`);
    if (result.correction) {
      console.log(`Correction: ${result.correction}`);
    }
    console.log("");
  } else {
    console.log(`${status} - ${inputPath}: ${JSON.stringify(result)}`);
    console.log("");
  }
}

// Test with cwd=pi-fc-search directory
const cwd_pi = "C:\\Users\\Game\\MyDevEnv\\wd\\pi-fc-search";
console.log(`Testing with cwd: ${cwd_pi}\n`);

for (const [inputPath, expected] of testCases) {
  const result = resolveDockerMountPath(inputPath, cwd_pi);
  console.log(`Input: ${inputPath}`);
  if (result) {
    console.log(`✓ Resolved to: ${result.resolved.replace(/\\{2,}/g, "\\")}`);
    if (result.correction) {
      console.log(`Correction: ${result.correction}`);
    }
  } else {
    console.log(`✗ Failed to resolve`);
  }
  console.log("");
}
