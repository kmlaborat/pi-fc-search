/**
 * FastContext agent implementation.
 * Ported from src/fastcontext/agent/agent.py
 */

import { randomUUID } from "crypto";
import type { LLMClient, NormalizedToolCall } from "./llm.js";
import { normalizeToolCalls } from "./llm.js";
import { CancelledError, LLMAPIError } from "./errors.js";
import type { ToolSet, FunctionCall } from "./tools/types.js";
import { Context } from "./context.js";
import { loadSystemPrompt } from "./prompt.js";
import { getFinalAnswer } from "./utils.js";

export interface AgentRunOptions {
  prompt: string;
  maxTurns?: number;
  citation?: boolean;
  signal?: AbortSignal; // For cancellation support
  onTurn?: (n: number, maxTurns: number) => void; // Optional per-turn progress hook
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
    return await this._agentLoop(options.prompt, maxTurns, citation, signal, options.onTurn);
  }

  private async _agentLoop(
    prompt: string,
    maxTurns: number,
    citation: boolean,
    signal?: AbortSignal,
    onTurn?: (n: number, maxTurns: number) => void
  ): Promise<string> {
    let nTurn = 0;

    // Add system prompt
    await this.context.add({ role: "system", content: this.systemPrompt });

    // Add user prompt
    await this.context.add({ role: "user", content: prompt });

    while (true) {
      // Check for cancellation at start of each turn
      if (signal && signal.aborted) {
        throw new CancelledError();
      }

      nTurn++;
      this.nTurn = nTurn;

      // Report progress (extension surfaces this via tool updates)
      onTurn?.(nTurn, maxTurns);

      // Check max turns
      if (nTurn > maxTurns + 1) {
        return `No final answer after ${maxTurns} turns.`;
      }

      // Inject "please provide final answer" at the last turn.
      // (D-007, SPEC §18): that forced turn is also called WITHOUT tools, so the
      // server cannot answer with another tool call. Upstream left tools enabled
      // on the final turn; models that ignore the text injection would burn the
      // last turn on tool execution and the agent exited with "No final answer"
      // despite having the information. Removing the tools array structurally
      // forces a text response; the mandated exit message is unchanged for the
      // (rare) case where the model still fails to answer.
      const isFinalTurn = nTurn === maxTurns + 1;
      if (isFinalTurn) {
        await this.context.add({
          role: "user",
          content: "Max number of turns reached. Please provide the final answer based on the information you have gathered."
        });
      }

      // Call LLM to get next action. No surrounding try/catch: CancelledError
      // (D-014, SPEC §18) and LLMAPIError (D-021, SPEC §18) must propagate
      // untouched to the extension, which maps them to a cancel result / an
      // isError: true tool result respectively. Returning error text as a
      // "successful" answer (upstream parity) let the host agent reason over
      // it as search output.
      const stepResult = await this.llm.acall(
        this.context.getMessages(),
        isFinalTurn ? undefined : this.toolset.schemaList(),
        signal // Pass abort signal to LLM client for cancellation
      );

      // Add raw message object directly to history (preserves server structure)
      await this.context.add(stepResult.raw);

      // If LLM requested tool calls, execute them using normalized struct
      const toolCalls = stepResult.normalizedToolCalls;

      if (toolCalls && toolCalls.length > 0) {
        const toolResults = await this.toolset.callNormalized(toolCalls);

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
          // truncated by the max token limit). (D-021, SPEC §18) thrown as a
          // typed error (not returned as "[ERROR] ..." text) so the extension
          // flags the tool result isError: true — an empty final answer is a
          // failed search, not an answer.
          throw new LLMAPIError(
            "The LLM returned an empty response (output may have been truncated). Please retry the search."
          );
        }
        return citation ? getFinalAnswer(content) : content;
      }
    }
  }
}