/**
 * Message history and trajectory JSONL writer.
 * Ported from src/fastcontext/agent/context.py
 */

import { mkdirSync } from "fs";
import { appendFile } from "fs/promises";
import { dirname } from "path";
import type { Message, NormalizedToolCall } from "./llm.js";

/**
 * (D-047, SPEC §18) Hard budget on the COMBINED size of tool-result
 * messages in the conversation history.
 *
 * Measured in UTF-8 bytes of each `role: "tool"` message's `content`
 * STRING — the exact string that gets serialized into the LLM API request.
 * This is a byte budget, not a token estimate (no bytes→tokens conversion
 * is part of the spec). It bounds what the prefill of the NEXT LLM call
 * must process: without it, a few large tool outputs (e.g. a whole-file
 * Read of a design doc) grow the prompt until a single cold prefill exceeds
 * the total execution timeout (2026-08-18 incident: 43k-token prompt,
 * ~95s prefill, 120s timeout).
 *
 * This is the combined-history constraint; the single-call Read output cap
 * (tools/read.ts, D-048) is a separate constraint.
 */
export const TOOL_RESULT_BUDGET_BYTES = 64 * 1024; // 64 KiB

export interface ToolResultEvictionReport {
  /** Number of tool results stubbed by this call. */
  evictedCount: number;
  /** Combined tool-result content bytes before eviction. */
  bytesBefore: number;
  /**
   * Combined tool-result content bytes AFTER eviction — re-measured with
   * the STUB sizes included. The eviction loop runs until this is ≤ the
   * budget (or no un-stubbed tool result remains).
   */
  bytesAfter: number;
}

/** Marker prefix of an evicted (stubbed) tool result. */
export const EVICTION_STUB_MARKER = "[Tool result evicted";

function toolContentBytes(msg: Record<string, unknown>): number {
  const content = msg.content;
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
}

function isEvictionStub(msg: Record<string, unknown>): boolean {
  return (
    typeof msg.content === "string" &&
    msg.content.startsWith(EVICTION_STUB_MARKER)
  );
}

/**
 * (D-047, SPEC §18) Pure eviction function (exported for unit tests).
 *
 * Given an append-ordered message history, stubs tool results oldest-first
 * until the combined UTF-8 byte size of ALL tool-message contents
 * (stubs counted at their stub size, re-measured after each replacement)
 * is ≤ `budgetBytes`.
 *
 * Guarantees:
 * - Only `role: "tool"` messages are touched; their `tool_call_id` (and any
 *   other fields) are preserved — only `content` is replaced.
 * - Non-tool messages are never modified.
 * - Idempotent: already-stubbed results are never re-stubbed.
 * - The "keep the most recent results full" behavior is emergent (oldest-
 *   first eviction), NOT a guarantee: if even the most recent results put
 *   the history over budget, they are stubbed too. The budget is strict.
 * - The stub carries re-acquisition metadata: tool name + arguments
 *   (looked up from the matching assistant tool_call by tool_call_id),
 *   the original size in bytes, and the first line of the original output
 *   (for Read this is the "path:start-end" header).
 *
 * Returns a new history array (stubbed entries are replaced with new
 * objects; all other entries are shared by reference) plus a report.
 */
export function evictToolResults(
  history: Record<string, unknown>[],
  budgetBytes: number
): { history: Record<string, unknown>[]; report: ToolResultEvictionReport } {
  const measure = (arr: Record<string, unknown>[]) =>
    arr.reduce(
      (sum, m) => (m.role === "tool" ? sum + toolContentBytes(m) : sum),
      0
    );

  const bytesBefore = measure(history);
  if (bytesBefore <= budgetBytes) {
    return {
      history,
      report: { evictedCount: 0, bytesBefore, bytesAfter: bytesBefore },
    };
  }

  // Map tool_call_id -> {name, arguments} from assistant messages so each
  // stub can carry re-acquisition metadata.
  const callInfo = new Map<string, { name: string; arguments: string }>();
  for (const m of history) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls as any[]) {
      const id = tc?.id;
      if (typeof id !== "string" || callInfo.has(id)) continue;
      const args = tc?.function?.arguments;
      callInfo.set(id, {
        name:
          typeof tc?.function?.name === "string" ? tc.function.name : "unknown",
        arguments:
          typeof args === "string"
            ? args
            : JSON.stringify(args ?? {}),
      });
    }
  }

  let evictedCount = 0;
  // Work on a shallow copy: stubbed slots are replaced with new objects,
  // un-stubbed entries are shared by reference. measure() always reads the
  // WORKING array so the termination condition sees POST-stub sizes.
  const result = history.slice();

  // Oldest first (history is append-ordered). Re-measure after each
  // replacement: the termination condition uses the POST-stub byte sizes.
  for (let i = 0; i < result.length; i++) {
    if (measure(result) <= budgetBytes) break;
    const msg = result[i];
    if (msg.role !== "tool" || isEvictionStub(msg)) continue;

    const original = msg.content as string;
    const originalBytes = Buffer.byteLength(original, "utf8");
    const firstLine = original.split("\n", 1)[0].slice(0, 200);
    const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
    const info = id ? callInfo.get(id) : undefined;

    const stub =
      `${EVICTION_STUB_MARKER} to keep tool results under the ${budgetBytes}-byte budget; original size ${originalBytes} bytes.` +
      (info ? ` Tool: ${info.name}, arguments: ${info.arguments.slice(0, 200)}.` : "") +
      (firstLine ? ` First line of original output: ${firstLine}.` : "") +
      ` Re-run the tool (with narrower arguments if it was large) or Read the file with offset and limit to retrieve the content again.`;

    result[i] = { ...msg, content: stub };
    evictedCount++;
  }

  return {
    history: evictedCount > 0 ? result : history,
    report: {
      evictedCount,
      bytesBefore,
      bytesAfter: measure(result),
    },
  };
}

export class Context {
  /**
   * Raw message objects as returned by the LLM server (unmodified except for
   * the metadata stripping in add()). Tool call normalization is exported
   * separately for execution; it never flows back into this history array —
   * breaking the round-trip transformation chain.
   */
  private history: Record<string, unknown>[];
  trajectoryFile: string;

  constructor(trajectoryFile: string) {
    this.history = [];
    this.trajectoryFile = trajectoryFile;

    // Create directory if it doesn't exist
    const dirPath = dirname(trajectoryFile);
    try {
      mkdirSync(dirPath, { recursive: true });
    } catch {
      // Directory likely already exists
    }
  }

  /**
   * Add message(s) to history and write trajectory JSONL line.
   */
  async add(message: Message | Message[]): Promise<void> {
    const messages = Array.isArray(message) ? message : [message];

    // Store raw objects directly, excluding metadata fields
    const cleanMessages = messages.map(msg => ({
      ...msg,
      // Remove optional meta fields if present
      model: undefined,
      usage: undefined,
      reasoning_content: undefined,
    }));

    this.history.push(...(cleanMessages as unknown as Record<string, unknown>[]));

    // Write to trajectory file (JSONL format)
    try {
      // One compact JSON object per line — strict JSONL so the trajectory
      // can be parsed line-by-line with standard tooling.
      // Written from cleanMessages (not the original input) so the
      // trajectory matches exactly what is kept in history and sent to the
      // API — without server metadata (model/usage/reasoning_content).
      const lines = cleanMessages.map(msg => {
        const obj: any = {};
        for (const [key, value] of Object.entries(msg)) {
          if (value !== null && value !== undefined) {
            obj[key] = value;
          }
        }
        return JSON.stringify(obj);
      });

      // (Review fix) async append instead of writeFileSync — the write is
      // awaited, so ordering semantics are unchanged, but a slow disk no
      // longer blocks the host (pi) event loop mid-search.
      await appendFile(this.trajectoryFile, lines.join("\n") + "\n");
    } catch (error) {
      console.error(`[fastcontext] Failed to write trajectory: ${error}`);
    }
  }

  /**
   * Get all messages in history for LLM API call.
   */
  getMessages(): any[] {
    return this.history.map(entry => {
      const obj: any = {};
      for (const [key, value] of Object.entries(entry)) {
        if (value !== null && value !== undefined) {
          obj[key] = value;
        }
      }
      return obj;
    });
  }

  /**
   * (D-047, SPEC §18) Enforce the tool-result byte budget in place.
   *
   * The full tool results were already written to the trajectory file when
   * they were added (add() writes at append time), so stubbing the history
   * here loses nothing from the debug record — the trajectory keeps the
   * originals. Only what is SENT to the LLM is bounded.
   *
   * @returns report with the pre/post byte totals (post-stub re-measured)
   */
  evictToolResults(
    budgetBytes: number = TOOL_RESULT_BUDGET_BYTES
  ): ToolResultEvictionReport {
    const evicted = evictToolResults(this.history, budgetBytes);
    this.history = evicted.history;
    return evicted.report;
  }
}
