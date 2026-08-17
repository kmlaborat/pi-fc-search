/**
 * Per-turn progress callback (onTurn) integration test.
 *
 * Verifies that the optional onTurn hook fires once per agent turn with the
 * current turn number and the configured maxTurns.
 */

import { describe, test, expect, vi, afterAll } from 'vitest';
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";

function stubFetchReturningToolCallThenAnswer(): void {
  let calls = 0;
  vi.stubGlobal('fetch', async (_url: string, _options: RequestInit) => {
    calls++;
    if (calls === 1) {
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
                id: "call_progress_test",
                type: "function",
                function: {
                  name: "Glob",
                  arguments: JSON.stringify({ pattern: "**/*.ts" })
                }
              }]
            },
            finish_reason: "tool_calls"
          }]
        }),
        text: () => Promise.resolve(""),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({
        choices: [{
          message: {
            role: "assistant",
            content: "Done.\n\n<final_answer>\nfile.ts:1-5\n</final_answer>"
          },
          finish_reason: "stop"
        }]
      }),
      text: () => Promise.resolve(""),
    };
  });
}

describe("onTurn progress callback", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test("fires once per turn with (n, maxTurns)", async () => {
    const tmpDir = path.join("/tmp", `fc_onturn_${randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      stubFetchReturningToolCallThenAnswer();

      const { runFastContextAgent } = await import('../../src/fastcontext-agent/index.js');

      const turns: Array<[number, number]> = [];
      await runFastContextAgent({
        prompt: "Find typescript files",
        cwd: tmpDir,
        maxTurns: 5,
        citation: false,
        llm: {
          model: "test-model",
          apiKey: "test-key",
          baseUrl: "http://localhost:8001/v1",
        },
        onTurn: (n, max) => turns.push([n, max]),
      });

      // Two LLM calls → two turns, each reported with maxTurns = 5
      expect(turns).toEqual([[1, 5], [2, 5]]);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
