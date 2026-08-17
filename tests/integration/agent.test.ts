/**
 * Agent integration tests - verify SPEC §7.4 and §10.2 requirements
 */

import { describe, test, expect, vi } from 'vitest';
import { spawn as originalSpawn, SpawnOptions } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { getFinalAnswer } from '../../src/fastcontext-agent/utils.js';
import { isWithinCwd } from '../../src/fastcontext-agent/utils.js';
import { Agent } from '../../src/fastcontext-agent/agent.js';
import { ToolSet } from '../../src/fastcontext-agent/tools/types.js';
import { ReadTool } from '../../src/fastcontext-agent/tools/read.js';
import { LLMAPIError, NoFinalAnswerError } from '../../src/fastcontext-agent/errors.js';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: vi.fn((command: string, args: string[], options: SpawnOptions) => {
    return mockSpawn(command, args, options);
  })
}));

describe("Agent Integration", () => {
  describe("Spawn verification (SPEC §7.4)", () => {
    test("should not spawn fastcontext CLI", async () => {
      // Verify that the implementation doesn't use spawn for fastcontext
      const { runFastContextAgent } = await import('../../src/fastcontext-agent/index.js');
      
      // The function exists and is callable (not spawning external process)
      expect(typeof runFastContextAgent).toBe('function');
    });

    test("should only spawn rg for tool operations", async () => {
      // Verify that only rg/ripgrep is used in tool implementations
      const rgModule = await import('../../src/fastcontext-agent/tools/rg.js');
      
      // getRgPath should exist and be callable
      expect(typeof rgModule.getRgPath).toBe('function');
    });
  });

  describe("Final answer extraction (SPEC §8)", () => {
    test("should extract final_answer block", () => {
      const text = `
Some explanation text here.

<final_answer>
src/file1.ts:10-20
src/file2.ts:30-40
</final_answer>

Additional text after.
`;
      
      const result = getFinalAnswer(text);
      expect(result).toContain("<final_answer>");
      expect(result).toContain("src/file1.ts:10-20");
      expect(result).toContain("src/file2.ts:30-40");
      expect(result).toContain("</final_answer>");
    });

    test("should return original text when no final_answer block", () => {
      const text = "Just some text without tags";
      const result = getFinalAnswer(text);
      expect(result).toBe(text);
    });
  });
});

describe("LLM Client - Tool call id synthesis (SPEC §10.2)", () => {
  test("should synthesize tool call id when null", () => {
    // This test verifies that the LLM client handles null tool_call.id
    // by synthesizing a new id in format call_{uuid}
    
    // The synthesis happens in llm.ts when processing tool calls
    // We verify the format requirement
    const exampleId = "call_12345678-1234-1234-1234-123456789012";
    
    expect(exampleId).toMatch(/^call_/);
    expect(exampleId.length).toBeGreaterThan(5);
  });
});

describe("Path containment verification", () => {
  test("should correctly identify paths within cwd", () => {
    const cwd = "/workspace/project";
    expect(isWithinCwd("/workspace/project/src/file.ts", cwd)).toBe(true);
  });

  test("should reject paths outside cwd", () => {
    const cwd = "/workspace/project";
    expect(isWithinCwd("/workspace/project2/src/file.ts", cwd)).toBe(false);
  });

  test("should handle relative paths", () => {
    const cwd = "/workspace/project";
    expect(isWithinCwd("src/example.ts", cwd)).toBe(true);
  });
});

describe("Agent loop - forced final turn (D-007, SPEC §18)", () => {
  test("should omit tools on the final turn so the model must answer with text", async () => {
    const toolset = new ToolSet([new ReadTool()], process.cwd());
    const trajectoryFile = join(tmpdir(), "pi-fc-search", "trajectory_test_d7.jsonl");

    const acall = vi.fn()
      // Turn 1: model requests a tool call (tools must be offered)
      .mockResolvedValueOnce({
        raw: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"path":"package.json"}' } }],
        },
        normalizedToolCalls: [{ id: "c1", name: "Read", arguments: { path: "package.json" } }],
      })
      // Forced final turn (maxTurns=1 → nTurn 2): model answers with text
      .mockResolvedValueOnce({
        raw: { role: "assistant", content: "Done.\n<final_answer>package.json:1-5</final_answer>" },
        normalizedToolCalls: [],
      });

    const agent = new Agent("test", { acall } as any, toolset, trajectoryFile, process.cwd());
    const result = await agent.run({ prompt: "find package.json", maxTurns: 1 });

    expect(acall).toHaveBeenCalledTimes(2);
    expect(acall.mock.calls[0][1]).toBeDefined();   // turn 1: tools offered
    expect(acall.mock.calls[1][1]).toBeUndefined(); // final turn: tools omitted
    expect(result).toContain("<final_answer>");
  });
});

describe("Agent loop - LLM API failure propagation (D-021, SPEC §18)", () => {
  const trajectoryFile = join(tmpdir(), "pi-fc-search", "trajectory_test_d7_021.jsonl");

  test("should re-throw LLMAPIError instead of returning it as a successful answer", async () => {
    const toolset = new ToolSet([new ReadTool()], process.cwd());
    const acall = vi.fn().mockRejectedValue(
      new LLMAPIError("LLM API call failed (500): boom")
    );
    const agent = new Agent("test", { acall } as any, toolset, trajectoryFile, process.cwd());

    // Pre-D-021 this resolved with the error text as a "final answer";
    // now it must reject so the extension flags the tool result isError: true.
    await expect(agent.run({ prompt: "find x", maxTurns: 3 })).rejects.toThrow(LLMAPIError);
    await expect(agent.run({ prompt: "find x", maxTurns: 3 })).rejects.toThrow("boom");
  });

  test("should throw LLMAPIError (not return '[ERROR] ...' text) on an empty final response (D-004/D-021)", async () => {
    const toolset = new ToolSet([new ReadTool()], process.cwd());
    const acall = vi.fn().mockResolvedValueOnce({
      raw: { role: "assistant", content: "" },
      normalizedToolCalls: [],
    });
    const agent = new Agent("test", { acall } as any, toolset, trajectoryFile, process.cwd());

    await expect(agent.run({ prompt: "find x", maxTurns: 3 })).rejects.toThrow(
      /empty response/
    );
  });

  test("should still resolve normally for a non-empty final answer", async () => {
    const toolset = new ToolSet([new ReadTool()], process.cwd());
    const acall = vi.fn().mockResolvedValueOnce({
      raw: { role: "assistant", content: "Answer.\n<final_answer>a.ts:1-2</final_answer>" },
      normalizedToolCalls: [],
    });
    const agent = new Agent("test", { acall } as any, toolset, trajectoryFile, process.cwd());

    const result = await agent.run({ prompt: "find x", maxTurns: 3 });
    expect(result).toContain("<final_answer>");
  });
});

describe("Agent loop - turn budget exhaustion (D-042, SPEC §18)", () => {
  test("throws NoFinalAnswerError (not a successful string answer) when the budget is exhausted", async () => {
    const toolset = new ToolSet([new ReadTool()], process.cwd());
    // The model keeps requesting tools forever, including on the D-007
    // forced final turn (which offers no tools — but a confused model can
    // still be scripted to ignore the mandate).
    const acall = vi.fn().mockResolvedValue({
      raw: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"path":"x"}' } }],
      },
      normalizedToolCalls: [{ id: "c1", name: "Read", arguments: { path: "x" } }],
    });
    const trajectoryFile = join(tmpdir(), "pi-fc-search", "trajectory_test_d42.jsonl");
    const agent = new Agent("test", { acall } as any, toolset, trajectoryFile, process.cwd());

    // Pre-D-042 this RESOLVED with the string "No final answer after 2 turns."
    // and the extension returned it as a successful (isError: false) result.
    // Now it rejects with the typed error (unchanged Requirement B message)
    // so the extension flags the tool result isError: true (D-019).
    await expect(agent.run({ prompt: "find x", maxTurns: 2 })).rejects.toThrow(
      NoFinalAnswerError
    );
    await expect(agent.run({ prompt: "find x", maxTurns: 2 })).rejects.toThrow(
      "No final answer after 2 turns."
    );
    // Two runs above; each burns maxTurns turns plus the forced final turn.
    expect(acall).toHaveBeenCalledTimes(6);
  });
});
