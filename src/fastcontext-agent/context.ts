/**
 * Message history and trajectory JSONL writer.
 * Ported from src/fastcontext/agent/context.py
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Message } from "./llm.js";

export class Context {
  private history: Message[];
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

    // Exclude metadata fields for history (model, usage, reasoning_content)
    const cleanMessages = messages.map(msg => ({
      ...msg,
      // Remove optional meta fields if present
      model: undefined,
      usage: undefined,
      reasoning_content: undefined,
    }));

    this.history.push(...cleanMessages);

    // Write to trajectory file (JSONL format)
    try {
      const lines = messages.map(msg => {
        const obj: any = {};
        for (const [key, value] of Object.entries(msg)) {
          if (value !== null && value !== undefined) {
            obj[key] = value;
          }
        }
        return JSON.stringify(obj, null, 2);
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
    return this.history.map(msg => {
      const obj: any = {};
      for (const [key, value] of Object.entries(msg)) {
        if (value !== null && value !== undefined) {
          obj[key] = value;
        }
      }
      return obj;
    });
  }
}
