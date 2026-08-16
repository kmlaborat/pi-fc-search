/**
 * Message history and trajectory JSONL writer.
 * Ported from src/fastcontext/agent/context.py
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Message, NormalizedToolCall } from "./llm.js";

/**
 * Internal storage format that preserves the raw API message object.
 * Tool call normalization is exported separately for execution; it never
 * flows back into this history array — breaking the round-trip transformation chain.
 */
interface HistoryEntry {
  /** The raw message object as returned by the LLM server (unmodified) */
  raw: any;
}

export class Context {
  private history: HistoryEntry[];
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

    this.history.push(...(cleanMessages as HistoryEntry[]));

    // Write to trajectory file (JSONL format)
    try {
      // One compact JSON object per line — strict JSONL so the trajectory
      // can be parsed line-by-line with standard tooling.
      const lines = messages.map(msg => {
        const obj: any = {};
        for (const [key, value] of Object.entries(msg)) {
          if (value !== null && value !== undefined) {
            obj[key] = value;
          }
        }
        return JSON.stringify(obj);
      });

      writeFileSync(this.trajectoryFile, lines.join("\n") + "\n", { flag: "a" });
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
   * Read-only access to raw message objects for inspection.
   * These should never be modified — they are sent verbatim to the API.
   */
  getRawMessages(): any[] {
    return this.history.slice();
  }
}
