/**
 * History round-trip integration test.
 *
 * Verifies the core history invariant: raw server messages (including the
 * nested `tool_calls` structure) are stored unmodified and sent back verbatim
 * on the next turn, while tool results are appended as `role: "tool"`
 * messages with matching `tool_call_id`. Server metadata (model/usage) must
 * never leak into the request history.
 *
 * Uses a stubbed fetch so no real LLM endpoint is required.
 */

import { describe, test, expect, vi, afterAll } from 'vitest';
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";

// Mock fetch to capture request payloads
const requestLog: any[] = [];

function setupMockServer(): void {
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    // Capture request body
    const body = JSON.parse(options.body as string);
    requestLog.push({ url, body });

    if (requestLog.length === 1) {
      // First turn: assistant requests a tool call
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
                id: "call_roundtrip_test",
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
    }

    // Second turn onward: final answer
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({
        choices: [{
          message: {
            role: "assistant",
            content: "Found it.\n\n<final_answer>\n/workspace/src/example.ts:10-20\n</final_answer>"
          },
          finish_reason: "stop"
        }]
      }),
      text: () => Promise.resolve(""),
    };
  });
}

describe("History round-trip - raw message preservation across turns", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test("2nd turn request preserves raw tool_calls and appends tool result", async () => {
    const tmpDir = path.join("/tmp", `fc_roundtrip_${randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      setupMockServer();
      requestLog.length = 0;

      const { runFastContextAgent } = await import('../../src/fastcontext-agent/index.js');

      await runFastContextAgent({
        prompt: "Find test_func",
        cwd: tmpDir,
        maxTurns: 3,
        citation: false,
        llm: {
          model: "test-model",
          apiKey: "test-key",
          baseUrl: "http://localhost:8001/v1",
        },
      });

      // Two LLM calls: turn 1 (tool call) and turn 2 (final answer)
      expect(requestLog.length).toBe(2);

      const secondTurnMessages = requestLog[1].body.messages;

      // Message order: system, user, assistant (tool_calls), tool, assistant, ...
      const assistantIdx = secondTurnMessages.findIndex((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));
      expect(assistantIdx).toBeGreaterThanOrEqual(0);

      // Raw tool_calls structure preserved verbatim (nested function object)
      const toolCall = secondTurnMessages[assistantIdx].tool_calls[0];
      expect(toolCall.id).toBe("call_roundtrip_test");
      expect(toolCall.type).toBe("function");
      expect(toolCall.function.name).toBe("Grep");
      expect(toolCall.function.arguments).toBe(JSON.stringify({ pattern: "test_func", path: "/workspace" }));

      // Tool result appended with matching tool_call_id
      const toolMsgIdx = secondTurnMessages.findIndex((m: any) => m.role === "tool");
      expect(toolMsgIdx).toBeGreaterThan(assistantIdx);
      expect(secondTurnMessages[toolMsgIdx].tool_call_id).toBe("call_roundtrip_test");

      // No server metadata leaked into any history message
      for (const msg of secondTurnMessages) {
        expect(msg).not.toHaveProperty("usage");
        expect(msg).not.toHaveProperty("model");
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
