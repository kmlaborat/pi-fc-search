/**
 * OpenAI-compatible LLM client for fastcontext agent.
 * Ported from src/fastcontext/agent/llm.py
 */

export interface Message {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: FunctionCall[];
  tool_call_id?: string;
}

export interface FunctionCall {
  id: string;
  name: string;
  arguments: string;
  type?: string;
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
  verbose: boolean;

  constructor(
    model: string,
    apiKey: string,
    baseUrl: string,
    options?: {
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      verbose?: boolean;
    }
  ) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.maxTokens = options?.max_tokens ?? 32000;
    this.temperature = options?.temperature ?? 1.0;
    this.topP = options?.top_p ?? 0.95;
    this.verbose = options?.verbose ?? false;
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

      if (this.verbose) {
        console.log("[fastcontext] LLM Payload:", JSON.stringify(payload, null, 2));
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
        name: tc.function.name,
        arguments: tc.function.arguments,
        type: "function"
      }));

      return {
        role: choice.message.role,
        content: content,
        tool_calls: functionCalls,
        tool_call_id: functionCalls[0].id
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
    return `call_${Math.random().toString(36).substring(2, 14)}`;
  }
}
