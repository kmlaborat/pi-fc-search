/**
 * Utility functions for fastcontext agent.
 * Ported from src/fastcontext/agent/utils.py
 */

import { readFileSync } from "fs";
import { resolve as pathResolve } from "path";

/**
 * Check if a candidate path is within the specified working directory.
 * Windows-correct path containment implementation (SPEC §10)
 */
export function isWithinCwd(candidate: string, cwd: string): boolean {
  const resolvedCwd = pathResolve(cwd);
  const resolvedCandidate = pathResolve(cwd, candidate);
  const rel = require("node:path").relative(resolvedCwd, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !require("node:path").isAbsolute(rel));
}

/**
 * Extract <final_answer> block from text using regex.
 * Matches Python's get_final_answer implementation.
 */
export function getFinalAnswer(text: string): string {
  const match = /<final_answer>(.*?)<\/final_answer>/gs.exec(text);
  if (!match) {
    return text;
  }
  // Return full tag block including <final_answer>...</final_answer>
  return match[0];
}
