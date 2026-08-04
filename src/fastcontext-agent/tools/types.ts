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
  name: string;
  arguments: string; // JSON string
  type?: string;
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
   * Execute tool call from message
   * Sequential execution with per-call timeout and error isolation
   */
  async call(message: Message): Promise<ToolResult[]> {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return [];
    }

    const results: ToolResult[] = [];
    
    for (const toolCall of message.tool_calls) {
      try {
        // Create timeout promise
        const timeoutPromise = new Promise<ToolResult>((_, reject) => {
          setTimeout(() => reject(new Error(`Timeout after ${MAX_TOOLRUN_TIMEOUT}s`)), 
            MAX_TOOLRUN_TIMEOUT * 1000);
        });
        
        // Execute tool call
        const execPromise = this.executeSingleCall(toolCall as FunctionCall);
        
        results.push(await Promise.race([execPromise, timeoutPromise]));
      } catch (error) {
        // Isolate errors - don't cancel other calls
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
    const tool = this.toolDict[call.name];
    if (!tool) {
      return {
        toolCallId: call.id,
        output: `Tool \`${call.name}\` not found.`,
        failed: true
      };
    }

    // Validate JSON parameters
    try {
      JSON.parse(call.arguments || "{}");
    } catch {
      return {
        toolCallId: call.id,
        output: `Tool \`${call.name}\` arguments are invalid.`,
        failed: true
      };
    }

    try {
      const output = await tool.call(call.arguments, { cwd: this.workDir });
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
 * Helper to run ripgrep command
 */
export async function runRipgrep(args: string[], cwd: string): Promise<string> {
  // Import ripgrep path
  const rgModule = await import("@vscode/ripgrep");
  const rgPath = rgModule.rgPath || process.env.RIPGREP_PATH;
  
  if (!rgPath) {
    throw new Error("Could not find ripgrep binary. Ensure @vscode/ripgrep is installed.");
  }

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
