import { resolveDockerMountPath } from "./src/fastcontext-agent/utils.js";
import * as fs from "fs";
import * as path from "path";

const testCwd = "C:\\Users\\Game\\MyDevEnv\\wd\\test";

console.log("=== Integration Test: Path Resolution for real workspace ===\n");

// 1. /test/sample.js の修正確認
console.log("Test: /test/sample.js (cwd=test)");
const sampleResult = resolveDockerMountPath("/test/sample.js", testCwd);
console.log("Resolved:", JSON.stringify(sampleResult, null, 2));

if (sampleResult) {
  try {
    const content = fs.readFileSync(sampleResult.resolved, "utf-8");
    console.log("✓ File read successful!");
    console.log(`  Lines: ${content.split("\n").length}`);
    console.log("Preview:", content.substring(0, 100).replace(/\n/g, "\n") + "...");
  } catch (e) {
    console.log("✗ File read failed:", e.message);
  }
}

// 2. /duet.json の正常動作確認
console.log("\nTest: /duet.json (cwd=test)");
const duetResult = resolveDockerMountPath("/duet.json", testCwd);
console.log("Resolved:", JSON.stringify(duetResult, null, 2));

if (duetResult) {
  try {
    const content = fs.readFileSync(duetResult.resolved, "utf-8");
    console.log("✓ File read successful! Lines:", content.split("\n").length);
  } catch (e) {
    console.log("✗ File read failed:", e.message);
  }
}

// 3. pi-fc-search cwdのケース
console.log("\n=== With cwd=pi-fc-search ===");
const piCwd = "C:\\Users\\Game\\MyDevEnv\\wd\\pi-fc-search";

console.log("Test: /pi-fc-search/package.json (cwd=pi-fc-search)");
const pkgResult = resolveDockerMountPath("/pi-fc-search/package.json", piCwd);
console.log("Resolved:", JSON.stringify(pkgResult, null, 2));

if (pkgResult) {
  try {
    const content = fs.readFileSync(pkgResult.resolved, "utf-8");
    console.log("✓ File read successful! Lines:", content.split("\n").length);
  } catch (e) {
    console.log("✗ File read failed:", e.message);
  }
}
