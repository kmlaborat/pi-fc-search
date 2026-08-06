import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

// Clear old trajectory files for test workspace
const testTrajectoryDir = path.resolve("C:/Users/Game/MyDevEnv/wd/test/.fastcontext");
if (fs.existsSync(testTrajectoryDir)) {
  for (const file of fs.readdirSync(testTrajectoryDir)) {
    if (file.startsWith("trajectory_") && file.endsWith(".jsonl")) {
      fs.unlinkSync(path.join(testTrajectoryDir, file));
    }
  }
}

// Use node to run the fc_search integration test directly
const testScript = `
const path = require('path');
const cwd = "C:\\Users\\Game\\MyDevEnv\\wd\\test";
process.chdir(cwd);
process.env.FASTCONTEXT_ENDPOINT = "http://localhost:8081/v1";
process.env.FASTCONTEXT_API_KEY = "sk-test";

(async () => {
  const { runFastContextAgent } = require("C:/Users/Game/MyDevEnv/wd/pi-fc-search/src/fastcontext-agent/index.js");
  
  try {
    const result = await runFastContextAgent({
      cwd: cwd,
      description: "Find JS function definitions",
      prompt: "Find all the function definitions in JavaScript files and summarize what they do.",
      maxTurns: 10,
      timeout: 120000
    });
    
    console.log("\n\n=== RESULT ===");
    console.log(result);
  } catch (error) {
    console.error("Error:", error.message);
  }
})();
`;

fs.writeFileSync("C:/Users/Game/MyDevEnv/wd/pi-fc-search/temp-fc-test.js", testScript);

const child = spawn("node", ["C:/Users/Game/MyDevEnv/wd/pi-fc-search/temp-fc-test.js"], {
  cwd: "C:/Users/Game/MyDevEnv/wd/test",
  stdio: "inherit"
});

child.on('close', (code) => {
  // Find and read the new trajectory file
  const trajFiles = fs.readdirSync(testTrajectoryDir).filter(f => f.endsWith(".jsonl")).sort();
  
  if (trajFiles.length > 0) {
    console.log("\n\n=== TRAJECTORY LOG ===");
    const trajPath = path.join(testTrajectoryDir, trajFiles[trajFiles.length - 1]);
    const content = fs.readFileSync(trajPath, "utf-8");
    
    // Parse and pretty print JSONL
    const lines = content.split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        console.log(JSON.stringify(obj, null, 2));
      } catch {}
    }
  }
  
  // Cleanup
  fs.unlinkSync("C:/Users/Game/MyDevEnv/wd/pi-fc-search/temp-fc-test.js");
});

child.on('error', (error) => {
  console.error("Spawn error:", error.message);
});
