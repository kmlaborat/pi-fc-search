/**
 * Tool interfaces and types for fastcontext agent.
 * Ported from src/fastcontext/agent/tool/tool.py
 */

// (Review fix) FunctionCall is defined once in ../llm.js and re-exported
// here — the duplicate local definition drifted as a second source of
// truth for the OpenAI tool-call wire format.
import type { Message, FunctionCall } from "../llm.js";
export type { FunctionCall } from "../llm.js";

export const MAX_TOOLRUN_TIMEOUT = 10; // seconds per tool call timeout

/**
 * Tool interface - port of Python Tool base class
 */
export interface Tool {
  name: string;
  description: string;
  parameters: object; // JSON Schema format
  
  schema(): object;
  call(params: string, ctx: CallContext): Promise<string>;
}

/**
 * Tool result - port of Python ToolResult model
 */
export interface ToolResult {
  toolCallId: string;
  output: string;
  failed: boolean;
}

/**
 * Call context for tool execution
 */
export interface CallContext {
  cwd: string; // working directory the tool is scoped to
}

/**
 * Message with tool calls - represents an assistant message requesting tool usage
 */
export interface MessageWithToolCalls {
  role: string;
  content?: string;
  tool_calls?: FunctionCall[];
}

/**
 * Tool set - manages collection of tools
 */
export class ToolSet {
  private toolDict: Record<string, Tool>;
  public workDir: string;

  constructor(tools: Tool[], workDir: string) {
    this.toolDict = Object.fromEntries(tools.map(t => [t.name, t]));
    this.workDir = workDir;
  }

  /**
   * Get schema list for LLM tool calling
   */
  schemaList(): object[] {
    return Object.values(this.toolDict).map(tool => tool.schema());
  }

  /**
   * Run a single tool execution under the per-call timeout (SPEC §8.4).
   *
   * Shared by the normalized and message-based call paths so the timeout
   * behavior (duration, tool name in the message, timer cleanup once the
   * execution settles) is defined in exactly one place.
   */
  private callWithTimeout(name: string, execPromise: Promise<ToolResult>): Promise<ToolResult> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Tool \`${name}\` timed out after ${MAX_TOOLRUN_TIMEOUT}s.`)),
        MAX_TOOLRUN_TIMEOUT * 1000
      );
    });

    return Promise.race([
      // Clear the timer once the execution settles — otherwise a 10s
      // pending timer accumulates per tool call.
      execPromise.finally(() => {
        clearTimeout(timeoutHandle);
      }),
      timeoutPromise,
    ]);
  }

  /**
   * Execute normalized tool calls derived from raw message objects.
   * 
   * This is the primary call path — it accepts pre-normalized flat structs that are
   * never written back to the API, breaking the round-trip transformation chain.
   */
  async callNormalized(normalizedToolCalls: {id: string; name: string; arguments: Record<string, any>}[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    
    // Sequential execution with per-call timeout
    for (const call of normalizedToolCalls) {
      try {
        // SPEC §8.4: timeout ToolResult message includes the tool name
        // (via the shared callWithTimeout helper)
        const execPromise = this.executeNormalizedCall(call, this.workDir);
        results.push(await this.callWithTimeout(call.name, execPromise));
      } catch (error) {
        // Isolate errors - continue with remaining calls
        results.push({
          toolCallId: call.id,
          output: error instanceof Error ? error.message : "Unknown error",
          failed: true
        });
      }
    }
    
    return results;
  }

  private async executeNormalizedCall(call: {id: string; name: string; arguments: Record<string, any>}, workDir: string): Promise<ToolResult> {
    const tool = this.toolDict[call.name];
    if (!tool) {
      return {
        toolCallId: call.id,
        output: `Tool \`${call.name}\` not found.`,
        failed: true
      };
    }

    try {
      const args = JSON.stringify(call.arguments);
      const output = await tool.call(args, { cwd: workDir });
      return {
        toolCallId: call.id,
        output,
        failed: false
      };
    } catch (error) {
      return {
        toolCallId: call.id,
        output: error instanceof Error ? error.message : String(error),
        failed: true
      };
    }
  }

  /**
   * Execute tool calls from message.
   *
   * (Review note) Legacy API path: the agent loop (agent.ts) executes via
   * callNormalized(); this message-based path is retained for API
   * completeness (it mirrors the upstream ToolSet.call) and is covered by
   * tests/tools/toolset.test.ts.
   *
   * Sequential execution (matching original Python implementation behavior).
   * Per-call timeout of 10s and error isolation ensured.
   * 
   * SPEC §8.4: Original implementation processes sequentially; this port maintains
   * that behavior for consistency, though parallelization with Promise.all is
   * permissible if per-call error isolation and timeout are maintained.
   */
  async call(message: Message): Promise<ToolResult[]> {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return [];
    }

    const results: ToolResult[] = [];
    
    // Sequential execution - each call waits for the previous to complete
    for (const toolCall of message.tool_calls) {
      const call = toolCall as FunctionCall;
      try {
        // Per-call timeout with the tool name in the message (SPEC §8.4)
        // via the shared callWithTimeout helper.
        const execPromise = this.executeSingleCall(call);
        results.push(await this.callWithTimeout(call.function.name, execPromise));
      } catch (error) {
        // Isolate errors - continue with remaining calls
        results.push({
          toolCallId: call.id,
          output: error instanceof Error ? error.message : "Unknown error",
          failed: true
        });
      }
    }
    
    return results;
  }

  private async executeSingleCall(call: FunctionCall): Promise<ToolResult> {
    const tool = this.toolDict[call.function.name];
    if (!tool) {
      return {
        toolCallId: call.id,
        output: `Tool \`${call.function.name}\` not found.`,
        failed: true
      };
    }

    // Validate JSON parameters
    try {
      JSON.parse(call.function.arguments || "{}");
    } catch {
      return {
        toolCallId: call.id,
        output: `Tool \`${call.function.name}\` arguments are invalid.`,
        failed: true
      };
    }

    try {
      const output = await tool.call(call.function.arguments, { cwd: this.workDir });
      return {
        toolCallId: call.id,
        output,
        failed: false
      };
    } catch (error) {
      return {
        toolCallId: call.id,
        output: error instanceof Error ? error.message : String(error),
        failed: true
      };
    }
  }
}

/**
 * Helper to run ripgrep commands.
 * Re-exported from the centralized rg module for convenience.
 */
export { getRgPath, runRipgrep } from "./rg.js";
