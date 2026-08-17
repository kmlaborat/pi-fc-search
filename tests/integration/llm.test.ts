/**
 * LLM client tests - verify tool call structure and OpenAI API format compliance
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { LLMClient, Message, FunctionCall, normalizeToolCalls } from '../../src/fastcontext-agent/llm.js';

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

describe("normalizeToolCalls - argument formats (D-008, SPEC §18)", () => {
  test("should parse JSON-string arguments (OpenAI standard format)", () => {
    const out = normalizeToolCalls({
      tool_calls: [{ id: "1", function: { name: "Read", arguments: '{"path":"a.ts"}' } }],
    });
    expect(out).toEqual([{ id: "1", name: "Read", arguments: { path: "a.ts" } }]);
  });

  test("should accept object-form arguments from OpenAI-compatible servers", () => {
    const out = normalizeToolCalls({
      tool_calls: [{ id: "2", function: { name: "Grep", arguments: { pattern: "foo", "-i": true } } }],
    });
    expect(out).toEqual([{ id: "2", name: "Grep", arguments: { pattern: "foo", "-i": true } }]);
  });

  test("should fall back to empty object for malformed string arguments", () => {
    const out = normalizeToolCalls({
      tool_calls: [{ id: "3", function: { name: "Read", arguments: "{not-json" } }],
    });
    expect(out).toEqual([{ id: "3", name: "Read", arguments: {} }]);
  });

  test("should return empty list when no tool calls present", () => {
    expect(normalizeToolCalls({ role: "assistant", content: "hi" })).toEqual([]);
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

describe("LLMClient - transient failure retry (D-023, SPEC §18)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const okResponse = () =>
    createMockResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  const httpError = (status: number) =>
    ({ ok: false, status, text: () => Promise.resolve("server said no") }) as any;

  test("retries HTTP 500 and then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(httpError(500))
      .mockResolvedValueOnce(okResponse());
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    const result = await c.acall([{ role: "user", content: "hi" }]);

    expect(result.raw.content).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("retries HTTP 429", async () => {
    mockFetch
      .mockResolvedValueOnce(httpError(429))
      .mockResolvedValueOnce(okResponse());
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    await c.acall([{ role: "user", content: "hi" }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("retries network-level fetch errors (e.g. ECONNREFUSED)", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okResponse());
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    const result = await c.acall([{ role: "user", content: "hi" }]);
    expect(result.raw.content).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("does not retry non-retryable HTTP 400", async () => {
    mockFetch.mockResolvedValue(httpError(400));
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    await expect(c.acall([{ role: "user", content: "hi" }])).rejects.toThrow(/400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("gives up after 3 attempts on persistent 500", async () => {
    mockFetch.mockResolvedValue(httpError(500));
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    await expect(c.acall([{ role: "user", content: "hi" }])).rejects.toThrow(
      /LLM API call failed \(500\)/
    );
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test("does not retry an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    await expect(
      c.acall([{ role: "user", content: "hi" }], undefined, controller.signal)
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("omits the Authorization header when the API key is empty", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const c = new LLMClient("m", "", "http://x/v1", { retry_delay_ms: 1 });

    await c.acall([{ role: "user", content: "hi" }]);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  test("sends the Authorization header when the API key is set", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const c = new LLMClient("m", "secret", "http://x/v1", { retry_delay_ms: 1 });

    await c.acall([{ role: "user", content: "hi" }]);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret");
  });
});

describe("LLMClient - context overflow surfacing (D-027, SPEC §18)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const contextOverflow = (status: number, body: string) =>
    ({ ok: false, status, text: () => Promise.resolve(body) }) as any;

  test("maps a 400 context-length error to an actionable message without retrying", async () => {
    mockFetch.mockResolvedValue(
      contextOverflow(400, "This model's maximum context length is 8192 tokens; however, you requested 12000 tokens.")
    );
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    await expect(c.acall([{ role: "user", content: "hi" }])).rejects.toThrow(
      /exceeded the model's context window/
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("maps a 413 too-many-tokens error the same way", async () => {
    mockFetch.mockResolvedValue(contextOverflow(413, "Payload too large: too many tokens"));
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    await expect(c.acall([{ role: "user", content: "hi" }])).rejects.toThrow(/context window/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("does not rewrite other 400 errors", async () => {
    mockFetch.mockResolvedValue(contextOverflow(400, "Invalid value for 'temperature'"));
    const c = new LLMClient("m", "k", "http://x/v1", { retry_delay_ms: 1 });

    await expect(c.acall([{ role: "user", content: "hi" }])).rejects.toThrow(
      /LLM API call failed \(400\)/
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
