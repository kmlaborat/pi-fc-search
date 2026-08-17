/**
 * OpenAI-compatible LLM client for fastcontext agent.
 * Ported from src/fastcontext/agent/llm.py
 */

import { randomUUID } from "crypto";
import { loadEnvFile } from "./env.js";
import { DEFAULT_TEMPERATURE } from "./config.js";
import { CancelledError, ContextWindowError, LLMAPIError } from "./errors.js";

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

// (D-023, SPEC §18) Transient-failure retry policy. A single 5xx/429 or a
// dropped connection previously ended the whole search (and, pre-D-021,
// surfaced as a "successful" error-text answer). Chat completions are
// idempotent for our purposes (no server-side side effects), so bounded
// retries are safe.
const MAX_ATTEMPTS = 3; // initial call + 2 retries
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Sleep `ms`, resolving early if the signal aborts (no listener leaks). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class LLMClient {
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  /** Base delay between retry attempts (attempt n waits base * 2^(n-1)). */
  retryDelayMs: number;

  constructor(
    model: string,
    apiKey: string,
    baseUrl: string,
    options?: {
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      retry_delay_ms?: number;
    }
  ) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.maxTokens = options?.max_tokens ?? 32000;
    this.temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    this.topP = options?.top_p ?? 0.95;
    this.retryDelayMs = options?.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS;
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

    // An empty API key (local servers that ignore auth) must not send an
    // empty `Authorization: Bearer ` header — some servers reject it.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    // (D-023, SPEC §18) Bounded retry on transient failures: HTTP 408/429/5xx
    // and network-level fetch errors. Semantic errors (other 4xx, malformed
    // responses) and aborts are never retried. Backoff: retryDelayMs * 2^n.
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await sleep(this.retryDelayMs * 2 ** (attempt - 2), signal);
      }

      // Check for abort before fetch
      if (signal && signal.aborted) {
        throw new CancelledError();
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal, // Pass abort signal to fetch for cancellation
        });

        if (!response.ok) {
          const errorText = await response.text();
          // (D-027, SPEC §18) A 400/413 caused by the conversation exceeding
          // the model's context window is a distinct, common failure for the
          // small models this package targets (the history is unbounded by
          // design). Surface an actionable message instead of the raw server
          // body, which small-model servers phrase inconsistently.
          if (response.status === 400 || response.status === 413) {
            const lowered = errorText.toLowerCase();
            if (
              lowered.includes("context length") ||
              lowered.includes("context_length") ||
              lowered.includes("maximum context") ||
              lowered.includes("too many tokens") ||
              lowered.includes("maximum number of tokens") ||
              lowered.includes("context window")
            ) {
              // (D-029, SPEC §18) typed ContextWindowError: the message is the
              // D-027 text, but the extension now recognizes the failure by
              // type and retries once with a reduced turn budget.
              throw new ContextWindowError(
                "The search conversation exceeded the model's context window. " +
                "Re-run with a smaller max_turns or a more focused prompt."
              );
            }
          }
          const error = new LLMAPIError(`LLM API call failed (${response.status}): ${errorText}`);
          if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
            lastError = error;
            continue;
          }
          throw error;
        }

        let data: any;
        try {
          data = await response.json();
        } catch {
          // (D-036, SPEC §18) A 200 response whose body is not valid JSON is a
          // server defect, not a transient network failure: falling into the
          // generic catch below would have misclassified it as a network
          // error, burning the D-023 retries and backoffs against a
          // deterministic failure, and finally surfacing as the opaque
          // "LLM API call failed: Unexpected token ...". Thrown as a
          // semantic LLMAPIError — the catch below re-throws LLMAPIError,
          // so it is never retried.
          throw new LLMAPIError(
            "The LLM endpoint returned a response that is not valid JSON. " +
            "Check that FASTCONTEXT_ENDPOINT serves a standard OpenAI-compatible /chat/completions implementation."
          );
        }

        // Extract raw message and normalized tool calls separately
        return this.extractRawMessage(data);
      } catch (error) {
        if (error instanceof LLMAPIError) throw error; // non-retryable (or exhausted)
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
        // Network-level failure (ECONNREFUSED, DNS, TLS, ...) — retryable.
        const wrapped = new LLMAPIError(
          `LLM API call failed: ${error instanceof Error ? error.message : "Unknown error"}`
        );
        if (attempt < MAX_ATTEMPTS) {
          lastError = wrapped;
          continue;
        }
        throw wrapped;
      }
    }

    // Unreachable in practice (the loop returns or throws); keep the type
    // narrow for the exhaustiveness of the retry path.
    throw lastError ?? new LLMAPIError("LLM API call failed.");
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

    // (D-039, SPEC §18) A choice without a message (some servers return only
    // a finish_reason on partial/aborted completions) previously hit
    // `{ ...choice.message }` as a TypeError deep inside acall's generic
    // catch — misclassified as a transient network failure, which burned the
    // D-023 retries and backoffs on a deterministic server defect before
    // surfacing as the opaque "LLM API call failed: Cannot convert undefined
    // or null to object". Thrown as a semantic LLMAPIError, the catch re-
    // throws it immediately and it is never retried.
    if (choice.message === undefined || choice.message === null) {
      throw new LLMAPIError(
        "No message returned from LLM API call. " +
        "Check that FASTCONTEXT_ENDPOINT serves a standard OpenAI-compatible /chat/completions implementation."
      );
    }

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
