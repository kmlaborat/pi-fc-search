// Import from actual source code
import { resolveDockerMountPath } from "./src/fastcontext-agent/utils.js";

const cwd = "C:\\Users\\Game\\MyDevEnv\\wd\\test";
console.log("cwd:", cwd);

console.log("\nTest 1: /duet.json");
console.log(JSON.stringify(resolveDockerMountPath("/duet.json", cwd)));

console.log("\nTest 2: /test/sample.js");
console.log(JSON.stringify(resolveDockerMountPath("/test/sample.js", cwd)));
