/**
 * Tool interfaces and types for fastcontext agent.
 * Ported from src/fastcontext/agent/tool/tool.py
 */

import { spawn } from "child_process";
import type { Message, FunctionCall as LlmFunctionCall } from "../llm.js";

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
 * Function call definition
 */
export interface FunctionCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
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
        const timeoutPromise = new Promise<ToolResult>((_, reject) => {
          setTimeout(() => reject(new Error(`Tool timed out after ${MAX_TOOLRUN_TIMEOUT}s`)), 
            MAX_TOOLRUN_TIMEOUT * 1000);
        });

        // Execute through normalized call path
        const execPromise = this.executeNormalizedCall(call, this.workDir);

        results.push(await Promise.race([execPromise, timeoutPromise]));
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
        output: `Tool \\'${call.name}\' not found.`,
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
      try {
        // Create timeout promise
        const timeoutPromise = new Promise<ToolResult>((_, reject) => {
          setTimeout(() => reject(new Error(`Tool timed out after ${MAX_TOOLRUN_TIMEOUT}s`)), 
            MAX_TOOLRUN_TIMEOUT * 1000);
        });
        
        // Execute tool call
        const execPromise = this.executeSingleCall(toolCall as FunctionCall);
        
        results.push(await Promise.race([execPromise, timeoutPromise]));
      } catch (error) {
        // Isolate errors - continue with remaining calls
        results.push({
          toolCallId: (toolCall as FunctionCall).id,
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
 * Helper to run ripgrep command.
 * Re-exported from centralized rg path resolver for consistency.
 */
export { getRgPath } from "./rg.js";

/**
 * @deprecated Use the centralized getRipgrep function in tools/rg.ts instead.
 */
export async function runRipgrep(args: string[], cwd: string): Promise<string> {
  const { getRgPath } = await import("./rg.js");
  const rgPath = await getRgPath();

  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, shell: false });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Ripgrep exited with code ${code}`));
      }
    });
    
    child.on("error", (err) => reject(err));
  });
}
