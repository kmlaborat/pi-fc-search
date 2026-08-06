/**
 * LLM client tests - verify tool call structure and OpenAI API format compliance
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { LLMClient, Message, FunctionCall } from '../../src/fastcontext-agent/llm.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockResponse(data: object): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as any;
}

describe("LLMClient - Tool call structure (OpenAI API format compliance)", () => {
  let client: LLMClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new LLMClient(
      'fastapi-15b-instruct-v0.4',
      'test-api-key',
      'http://localhost:8001/fastcontext/v1'
    );
  });

  test("should return properly structured tool calls from OpenAI response", async () => {
    // Mock OpenAI API response with standard format
    const mockOpenAIResponse = {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_abc123",
            type: "function",
            function: {
              name: "Grep",
              arguments: JSON.stringify({ pattern: "test", path: "/workspace" })
            }
          }]
        },
        finish_reason: "tool_calls"
      }]
    };

    mockFetch.mockResolvedValue(createMockResponse(mockOpenAIResponse));

    const result = await client.acall([{ role: "user", content: "test" }]);

    // Verify raw message preserves original structure (for history)
    expect(result.raw.tool_calls).toBeDefined();
    expect(result.raw.tool_calls?.length).toBe(1);

    const toolCall = result.raw.tool_calls[0];
    
    // Verify nested structure - this is the key assertion for the bug fix
    expect(toolCall.id).toBe("call_abc123");
    expect(toolCall.type).toBe("function");
    expect(toolCall.function).toBeDefined();
    expect(toolCall.function.name).toBe("Grep");
    expect(toolCall.function.arguments).toContain("test");

    // Verify normalized tool calls exist for execution
    expect(result.normalizedToolCalls).toBeDefined();
    expect(result.normalizedToolCalls.length).toBe(1);
    expect(result.normalizedToolCalls[0].name).toBe("Grep");

    // Verify NO tool_call_id on assistant message (bug #3 fix)
    expect((result.raw as any).tool_call_id).toBeUndefined();
  });

  test("should handle mlx-lm format and synthesize missing tool call ids", async () => {
    // Mock response where tool_calls have null/missing id (mlx-lm case)
    const mockMlxResponse = {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: null, // mlx-lm often returns null
            type: "function", 
            function: {
              name: "Read",
              arguments: JSON.stringify({ path: "/test/file.ts" })
            }
          }]
        },
        finish_reason: "tool_calls"
      }]
    };

    mockFetch.mockResolvedValue(createMockResponse(mockMlxResponse));

    const result = await client.acall([{ role: "user", content: "test" }]);

    // Verify synthesized id in raw object (for history)
    expect(result.raw.tool_calls).toBeDefined();
    const toolCall = result.raw.tool_calls[0];
    expect(toolCall.id).toMatch(/^call_/);
    expect(toolCall.function.name).toBe("Read");

    // Also verify synthesized id in normalized struct (for execution)
    expect(result.normalizedToolCalls.length).toBe(1);
    expect(result.normalizedToolCalls[0].id).toMatch(/^call_/);
  });

  test("should flatten structure for internal use but maintain OpenAI format for requests", async () => {
    const mockResponse = {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_xyz",
            type: "function",
            function: {
              name: "Glob",
              arguments: JSON.stringify({ pattern: "*.ts" })
            }
          }]
        },
        finish_reason: "tool_calls"
      }]
    };

    mockFetch.mockResolvedValue(createMockResponse(mockResponse));

    // First call - get assistant message with tool calls
    const result = await client.acall([{ role: "user", content: "test" }]);

    // Verify raw structure preserved for request (nested format)
    expect(result.raw.tool_calls[0].function.name).toBe("Glob");

    // Verify normalized struct has flat format for execution
    expect(result.normalizedToolCalls.length).toBe(1);
    expect(result.normalizedToolCalls[0].name).toBe("Glob");
    expect(result.normalizedToolCalls[0]).not.toHaveProperty("function"); // Flat, not nested

    // Raw object preserves nested structure for next API request
    const rawToolCall = result.raw.tool_calls[0];
    expect(rawToolCall).toHaveProperty("id");
    expect(rawToolCall).toHaveProperty("type");
    expect(rawToolCall).toHaveProperty("function");
    expect(rawToolCall.function).toHaveProperty("name");
    expect(rawToolCall.function).toHaveProperty("arguments");
  });
});

describe("FunctionCall structure validation", () => {
  test("nested FunctionCall should be OpenAI API compliant", () => {
    const functionCall: FunctionCall = {
      id: "call_test_123",
      type: "function",
      function: {
        name: "Grep",
        arguments: JSON.stringify({ pattern: "test" })
      }
    };

    // Structure validation for OpenAI format
    expect(functionCall.id).toBeDefined();
    expect(functionCall.type).toBe("function");
    expect(functionCall.function).toBeDefined();
    expect(functionCall.function.name).toBe("Grep");
    expect(functionCall.function.arguments).toContain("test");
  });
});
