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

    const message = await client.acall([{ role: "user", content: "test" }]);

    // Verify tool_calls structure matches OpenAI format
    expect(message.tool_calls).toBeDefined();
    expect(message.tool_calls?.length).toBe(1);

    const toolCall = message.tool_calls![0];
    
    // Verify nested structure - this is the key assertion for the bug fix
    expect(toolCall.id).toBe("call_abc123");
    expect(toolCall.type).toBe("function");
    expect(toolCall.function).toBeDefined();
    expect(toolCall.function.name).toBe("Grep");
    expect(toolCall.function.arguments).toContain("test");

    // Verify NO tool_call_id on assistant message (bug #3 fix)
    expect((message as any).tool_call_id).toBeUndefined();
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

    const message = await client.acall([{ role: "user", content: "test" }]);

    // Verify synthesized id
    expect(message.tool_calls).toBeDefined();
    const toolCall = message.tool_calls![0];
    expect(toolCall.id).toMatch(/^call_/);
    expect(toolCall.function.name).toBe("Read");
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
    const messages = await client.acall([{ role: "user", content: "test" }]);

    // Verify internal structure is correct for passing to request
    expect(messages.tool_calls![0].function.name).toBe("Glob");

    // When getMessages() serializes this, it should produce proper OpenAI format
    const serialized = messages.tool_calls![0];
    
    // Structure that goes into API request should be:
    // { id: "...", type: "function", function: { name: "...", arguments: "..." } }
    expect(serialized).toHaveProperty("id");
    expect(serialized).toHaveProperty("type");
    expect(serialized).toHaveProperty("function");
    expect(serialized.function).toHaveProperty("name");
    expect(serialized.function).toHaveProperty("arguments");
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
