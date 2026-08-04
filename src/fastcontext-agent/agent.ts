/**
 * FastContext agent implementation.
 * Ported from src/fastcontext/agent/agent.py
 */

import { nanoid } from "nanoid";
import type { LLMClient, Message, FunctionCall as LlmFunctionCall } from "./llm.js";
import { RequestyAPIError } from "./llm.js";
import type { ToolSet, FunctionCall } from "./tools/types.js";
import { Context } from "./context.js";
import { loadSystemPrompt } from "./prompt.js";
import { getFinalAnswer } from "./utils.js";

export interface AgentRunOptions {
  prompt: string;
  maxTurns?: number;
  citation?: boolean;
  signal?: AbortSignal; // For cancellation support

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
    workDir: string,
    systemPrompt?: string
  ) {
    this.name = name;
    this.systemPrompt = systemPrompt || loadSystemPrompt(workDir);
    this.llm = llm;
    this.toolset = toolset;
    this.context = new Context(trajectoryFile);
    this.workDir = workDir;
    this.nTurn = 0;
    this.runId = nanoid(12);
  }

  async run(options: AgentRunOptions | { prompt: string; maxTurns?: number; citation?: boolean; signal?: AbortSignal }): Promise<string> {
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
        const stepMessage = await this.llm.acall(
          this.context.getMessages(),
          this.toolset.schemaList(),
          signal // Pass abort signal to LLM client for cancellation
        );

        await this.context.add(stepMessage);

        if (this.llm.verbose) {
          console.log(`Turn ${nTurn}:`, JSON.stringify(stepMessage, null, 2));
        }

        // If LLM requested tool calls, execute them
        if (stepMessage.tool_calls && stepMessage.tool_calls.length > 0) {
          const toolResults = await this.toolset.call(stepMessage as any);
          
          // Create messages for each tool result
          const toolMessages: Message[] = toolResults.map(result => ({
            role: "tool" as const,
            content: result.failed ? `[ERROR] ${result.output}` : result.output,
            tool_call_id: result.toolCallId
          }));

          await this.context.add(toolMessages);
        } else {
          // LLM provided final answer
          return citation ? getFinalAnswer(stepMessage.content || "") : (stepMessage.content || "");
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
