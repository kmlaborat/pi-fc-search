/**
 * FastContext agent implementation.
 * Ported from src/fastcontext/agent/agent.py
 */

import { randomUUID } from "crypto";
import type { LLMClient, NormalizedToolCall } from "./llm.js";
import { RequestyAPIError, normalizeToolCalls } from "./llm.js";
import type { ToolSet, FunctionCall } from "./tools/types.js";
import { Context } from "./context.js";
import { loadSystemPrompt } from "./prompt.js";
import { getFinalAnswer } from "./utils.js";

export interface AgentRunOptions {
  prompt: string;
  maxTurns?: number;
  citation?: boolean;
  signal?: AbortSignal; // For cancellation support
}

export class Agent {
  name: string;
  systemPrompt: string;
  llm: LLMClient;
  toolset: ToolSet;
  context: Context;
  workDir: string;
  nTurn: number;
  runId: string;

  constructor(
    name: string,
    llm: LLMClient,
    toolset: ToolSet,
    trajectoryFile: string,
    workDir: string
  ) {
    this.name = name;
    this.systemPrompt = loadSystemPrompt(workDir);
    this.llm = llm;
    this.toolset = toolset;
    this.context = new Context(trajectoryFile);
    this.workDir = workDir;
    this.nTurn = 0;
    this.runId = randomUUID().slice(0, 12);
  }

  async run(options: AgentRunOptions): Promise<string> {
    const maxTurns = options.maxTurns ?? 15;
    const citation = options.citation ?? false;
    const signal = options.signal;
    return await this._agentLoop(options.prompt as string, maxTurns, citation, signal);
  }

  private async _agentLoop(prompt: string, maxTurns: number, citation: boolean, signal?: AbortSignal): Promise<string> {
    let nTurn = 0;

    // Add system prompt
    await this.context.add({ role: "system", content: this.systemPrompt });

    // Add user prompt
    await this.context.add({ role: "user", content: prompt });

    while (true) {
      // Check for cancellation at start of each turn
      if (signal && signal.aborted) {
        throw new Error("Operation was cancelled");
      }

      nTurn++;
      this.nTurn = nTurn;

      // Check max turns
      if (nTurn > maxTurns + 1) {
        return `No final answer after ${maxTurns} turns.`;
      }

      // Inject "please provide final answer" at the last turn
      if (nTurn === maxTurns + 1) {
        await this.context.add({
          role: "user",
          content: "Max number of turns reached. Please provide the final answer based on the information you have gathered."
        });
      }

      // Call LLM to get next action
      try {
        const stepResult = await this.llm.acall(
          this.context.getMessages(),
          this.toolset.schemaList(),
          signal // Pass abort signal to LLM client for cancellation
        );

        // Add raw message object directly to history (preserves server structure)
        await this.context.add(stepResult.raw);

        // If LLM requested tool calls, execute them using normalized struct
        const toolCalls = stepResult.normalizedToolCalls;
        
        if (toolCalls && toolCalls.length > 0) {
          const toolResults = await this.toolset.callNormalized(toolCalls as any);

          // Create messages for each tool result
          const toolMessages: any[] = toolResults.map(result => ({
            role: "tool",
            content: result.failed ? `[ERROR] ${result.output}` : result.output,
            tool_call_id: result.toolCallId
          }));

          await this.context.add(toolMessages);
        } else {
          // LLM provided final answer — extract from raw object's content field
          const content =
            typeof stepResult.raw.content === "string" ? stepResult.raw.content : "";
          if (!content.trim()) {
            // Guard against servers returning empty/null content (e.g. output
            // truncated by the max token limit). Returning an empty string
            // surfaces to the caller as a mysterious "no response".
            return "[ERROR] The LLM returned an empty response (output may have been truncated). Please retry the search.";
          }
          return citation ? getFinalAnswer(content) : content;
        }
      } catch (error) {
        if (error instanceof RequestyAPIError) {
          const errorMessage = `LLM API call failed. So stopping the agent.\nError details:\n${error.message}`;
          await this.context.add({ role: "assistant", content: errorMessage });
          return errorMessage;
        }
        throw error;
      }
    }
  }
}