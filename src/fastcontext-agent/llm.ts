/**
 * OpenAI-compatible LLM client for fastcontext agent.
 * Ported from src/fastcontext/agent/llm.py
 */

import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";

/**
 * Load environment variables from .env file.
 * Searches in the following order:
 * 1. {process.cwd()}/.env
 * 2. {package-dir}/.env (directory of this module)
 * 3. {extensions-dir}/.env (extensions directory containing this package)
 */
function loadEnvFile(): void {
  const searchPaths = [
    resolve(process.cwd(), ".env"),
    resolve(dirname(import.meta.url), "..", "..", ".env"),
    resolve(dirname(import.meta.url), "..", "..", "node_modules", ".env"),
  ];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const lines = content.split(/\r?\n/);
        
        for (const line of lines) {
          const trimmed = line.trim();
          // Skip empty lines and comments
          if (!trimmed || trimmed.startsWith("#")) continue;
          
          // Parse KEY=VALUE format
          const eqIndex = trimmed.indexOf("=");
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();
            
            // Remove surrounding quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) || 
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            
            process.env[key] = value;
          }
        }
      } catch (e) {
        // Silently fail if .env file can't be read
      }
    }
  }
}

// Load environment variables at module initialization
loadEnvFile();

export interface Message {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: FunctionCall[];
  tool_call_id?: string;
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

export class RequestyAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestyAPIError";
  }
}

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
    this.temperature = options?.temperature ?? 1.0;
    this.topP = options?.top_p ?? 0.95;
  }

  async acall(messages: Message[], tools?: object[], signal?: AbortSignal): Promise<Message> {
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
        throw new Error("Operation was cancelled");
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
        throw new RequestyAPIError(`LLM API call failed (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      
      // Extract message from response
      return this.extractMessage(data, tools);
    } catch (error) {
      if (error instanceof RequestyAPIError) throw error;
      throw new RequestyAPIError(`LLM API call failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private extractMessage(responseData: any, tools?: object[]): Message {
    if (!responseData.choices || responseData.choices.length === 0) {
      throw new RequestyAPIError("No choices returned from LLM API call.");
    }

    const choice = responseData.choices[0];
    let content = choice.message?.content;
    const tool_calls_data = choice.message?.tool_calls;

    // Handle tool calls if present
    if (tool_calls_data && tool_calls_data.length > 0) {
      // Synthesize tool-call ids when missing (mlx-lm and other server compatibility fix)
      const functionCalls: FunctionCall[] = tool_calls_data.map((tc: any) => ({
        id: tc.id || this.synthesizeToolCallId(),
        type: "function",
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

      return {
        role: choice.message.role,
        content: content,
        tool_calls: functionCalls,
      };
    }

    // Regular message (no tool calls)
    return {
      role: choice.message.role,
      content: content || ""
    };
  }

  /**
   * Synthesize a tool call id when the server returns null/undefined.
   * mlx-lm compatibility fix from upstream repo.
   */
  private synthesizeToolCallId(): string {
    return `call_${randomUUID().slice(0, 32)}`;
  }
}
