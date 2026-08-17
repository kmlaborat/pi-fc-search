/**
 * OpenAI-compatible LLM client for fastcontext agent.
 * Ported from src/fastcontext/agent/llm.py
 */

import { randomUUID } from "crypto";
import { loadEnvFile } from "./env.js";
import { DEFAULT_TEMPERATURE } from "./config.js";
import { CancelledError, LLMAPIError } from "./errors.js";

// Load environment variables at module initialization (shared, idempotent loader)
loadEnvFile();

export interface Message {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: FunctionCall[];
  tool_call_id?: string;
}

/**
 * Internal normalized tool call structure for executing tools.
 * This is derived from raw server responses but NEVER written back to API requests.
 * 
 * Design principle: Raw message objects are kept in history unchanged; this struct
 * is exported read-only for internal tool execution and must not be round-tripped.
 */
export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * Normalize FC-server nested tool_calls structure to flat normalized format.
 * 
 * Server returns: [{id, function: {name, arguments}}]
 * This exports:  [{id, name, arguments}]
 * 
 * The raw message object remains unmodified in history — this output is a temporary
 * derived struct used only for tool execution and never written back to the API.
 */
export function normalizeToolCalls(rawMessage: any): NormalizedToolCall[] {
  const tool_calls_data = rawMessage?.tool_calls;
  
  if (!Array.isArray(tool_calls_data) || tool_calls_data.length === 0) {
    return [];
  }

  return tool_calls_data.map((tc: any) => {
    const id = tc.id || `call_${randomUUID().slice(0, 32)}`; // Synthesize if missing (mlx-lm compat)
    const name = tc.function?.name || "";
    let argumentsObj: Record<string, any> = {};

    const rawArgs = tc.function?.arguments;
    if (typeof rawArgs === "string") {
      try {
        argumentsObj = JSON.parse(rawArgs);
      } catch {
        argumentsObj = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      // (D-008, SPEC §18): some OpenAI-compatible servers return tool-call
      // arguments already parsed as a JSON object instead of a JSON string.
      // Upstream only handled the string form, silently dropping such
      // arguments to {}. Accept the object as-is.
      argumentsObj = rawArgs;
    }

    return { id, name, arguments: argumentsObj };
  });
}

export interface FunctionCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionPayload {
  model: string;
  messages: Message[];
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: object[];
}

// (D-015, SPEC §18): API errors use LLMAPIError from ./errors.js (the v2
// name `RequestyAPIError` was a porting leftover; messages are unchanged).

export class LLMClient {
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  temperature: number;
  topP: number;

  constructor(
    model: string,
    apiKey: string,
    baseUrl: string,
    options?: {
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
    }
  ) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.maxTokens = options?.max_tokens ?? 32000;
    this.temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    this.topP = options?.top_p ?? 0.95;
  }

  async acall(messages: Message[], tools?: object[], signal?: AbortSignal): Promise<{raw: any; normalizedToolCalls: NormalizedToolCall[]}> {
    const payload: ChatCompletionPayload = {
      model: this.model,
      messages,
      max_completion_tokens: this.maxTokens,
      temperature: this.temperature,
      top_p: this.topP,
    };

    if (tools) {
      payload.tools = tools;
    }

    const baseUrl = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const url = `${baseUrl}/chat/completions`;

    try {
      // Check for abort before fetch
      if (signal && signal.aborted) {
        throw new CancelledError();
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal, // Pass abort signal to fetch for cancellation
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LLMAPIError(`LLM API call failed (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      
      // Extract raw message and normalized tool calls separately
      return this.extractRawMessage(data);
    } catch (error) {
      if (error instanceof LLMAPIError) throw error;
      if (error instanceof CancelledError) throw error;
      // Re-throw aborts (timeout / user cancellation) unwrapped so callers can
      // inspect the linked AbortSignal and map the failure correctly. Wrapping
      // them in LLMAPIError previously made timeouts surface as
      // "LLM API call failed" and silently broke timeout/cancel handling.
      if (
        (error instanceof Error && error.name === "AbortError") ||
        (signal !== undefined && signal.aborted)
      ) {
        throw error;
      }
      throw new LLMAPIError(`LLM API call failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Extract message from API response, preserving the raw structure for history storage.
   * 
   * Returns both:
   * - `raw`: The unmodified message object from the server (for conversation history)
   * - `normalizedToolCalls`: A flat tool-calls struct derived for internal execution only
   */
  private extractRawMessage(responseData: any): { raw: any; normalizedToolCalls: NormalizedToolCall[] } {
    if (!responseData.choices || responseData.choices.length === 0) {
      throw new LLMAPIError("No choices returned from LLM API call.");
    }

    const choice = responseData.choices[0];
    
    // Ensure all required fields exist on the raw object (defensive fix for servers returning partial data)
    const rawMessage: any = { ...choice.message };
    
    // Synthesize tool_call ids only when missing (mlx-lm and other server compatibility)
    if (rawMessage.tool_calls && Array.isArray(rawMessage.tool_calls)) {
      for (const tc of rawMessage.tool_calls) {
        if (!tc.id) {
          tc.id = `call_${randomUUID().slice(0, 32)}`;
        }
      }
    }

    const normalizedToolCalls = normalizeToolCalls(rawMessage);

    return { raw: rawMessage, normalizedToolCalls };
  }
}
