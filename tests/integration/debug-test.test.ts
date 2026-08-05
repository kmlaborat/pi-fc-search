/**
 * Debug test - verify 2nd turn request body format after fix
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";

// Set up environment before importing module
process.env.FASTCONTEXT_API_KEY = "test-key";
process.env.FASTCONTEXT_ENDPOINT = "http://localhost:8001/fastcontext/v1";
process.env.FASTCONTEXT_MODEL = "fastapi-15b-instruct-v0.4";

// Mock fetch to capture request payloads
const requestLog: any[] = [];

function setupMockServer(): void {
  const turnCounter = { current: 0 };

  const originalFetch = global.fetch;
  
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    // Capture request body
    const body = JSON.parse(options.body as string);
    requestLog.push({ url, body });

    turnCounter.current++;

    if (turnCounter.current === 1) {
      // First turn: return assistant with tool call
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_debug_test",
                type: "function",
                function: {
                  name: "Grep",
                  arguments: JSON.stringify({ pattern: "test_func", path: "/workspace" })
                }
              }]
            },
            finish_reason: "tool_calls"
          }]
        }),
        text: () => Promise.resolve(""),
      };
    } else {
      // Second turn (after tool result)
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({
          choices: [{
            message: {
              role: "assistant",
              content: "Here are the matches for test_func:\n\n```typescript\nsrc/example.ts:10-20\n  function test_func() {\n    return true;\n  }\n```\n\n<final_answer>\nThe function `test_func` is found in:\n- src/example.ts:10-20 - Found one match with implementation\n</final_answer>"
            },
            finish_reason: "stop"
          }]
        }),
        text: () => Promise.resolve(""),
      };
    }
  });
}

async function captureRequestBody(): Promise<{ requestBody: any; secondTurnBody?: any }> {
  // Set up temp directory for test
  const tmpDir = path.join("/tmp", `debug_test_${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    setupMockServer();
    requestLog.length = 0;

    // Import after mocking
    const { runFastContextAgent } = await import('../../src/fastcontext-agent/index.js');
    
    try {
      await runFastContextAgent("Find test_func", { workDir: tmpDir, maxTurns: 3 });
    } catch (e) {
      // Expected to fail due to mocked environment
    }

    if (requestLog.length < 2) {
      return { requestBody: requestLog[0]?.body };
    }

    return {
      requestBody: requestLog[0].body,
      secondTurnBody: requestLog[1].body
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

describe("Debug - 2nd turn request body format verification", () => {
  test("should verify nested function structure in tool_calls payload", async () => {
    const result = await captureRequestBody();
    
    console.log("\n=== REQUEST LOG ===");
    console.log(`Total requests captured: ${requestLog.length}\n`);
    
    if (result.secondTurnBody) {
      console.log("=== SECOND TURN REQUEST BODY ===");
      
      const secondMsgs = result.secondTurnBody.messages;
      console.log(`Messages in 2nd turn request: ${secondMsgs.length}`);
      
      // Find the assistant message with tool_calls
      for (let i = 0; i < secondMsgs.length; i++) {
        const msg = secondMsgs[i];
        
        console.log(`\n--- Message ${i} (role: ${msg.role}) ---`);
        
        if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          console.log("\nTool calls in message:");
          
          for (let j = 0; j < msg.tool_calls.length; j++) {
            const toolCall = msg.tool_calls[j];
            console.log(`\n  Tool call ${j}:`);
            console.log(JSON.stringify(toolCall, null, 4));
            
            // Validate structure
            console.log("\n  Structure validation:");
            console.log(`    - Has 'id': ${!!toolCall.id}`);
            console.log(`    - Has 'type': ${!!toolCall.type}`);
            console.log(`    - Has 'function' (nested): ${!!toolCall.function}`);
            
            if (toolCall.function) {
              console.log(`    - function.name: ${toolCall.function.name}`);
              console.log(`    - function.arguments present: ${!!toolCall.function.arguments}`);
            }
          }
        }
      }
    }
  });
});
