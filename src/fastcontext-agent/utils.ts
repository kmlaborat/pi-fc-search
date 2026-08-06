/**
 * Utility functions for fastcontext agent.
 * Ported from src/fastcontext/agent/utils.py
 */

import { readFileSync } from "fs";
import { resolve as pathResolve } from "path";

import * as path from "node:path";

/**
 * Check if a candidate path is within the specified working directory.
 * Windows-correct path containment implementation (SPEC §10)
 */
export function isWithinCwd(candidate: string, cwd: string): boolean {
  const resolvedCwd = pathResolve(cwd);
  const resolvedCandidate = pathResolve(cwd, candidate);
  const rel = path.relative(resolvedCwd, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve Docker-mount-style absolute paths that the FastContext model frequently emits.
 * 
 * The model (trained in SWE-bench-like environments with /repo-name/ mounts) produces paths like:
 *   /pi-fc-search/package.json
 * which are not real filesystem paths but intended as "relative to repo root".
 * 
 * This function attempts to resolve such paths by trying multiple candidate strategies,
 * then verifies the result exists and is within cwd.
 * 
 * @param originalPath - The path as received from the LLM tool call
 * @param cwd - The working directory for the agent (must be absolute)
 * @returns Object with { resolved: string, correction?: string } or null if unresolvable
 */
export function resolveDockerMountPath(originalPath: string, cwd: string): { resolved: string; correction?: string } | null {
  const absCwd = pathResolve(cwd);

  // Strategy 1: Direct resolution - if the original path resolves within cwd and exists, use it
  const directResolved = pathResolve(absCwd, originalPath);
  if (isWithinCwd(directResolved, absCwd)) {
    return { resolved: directResolved };
  }

  // Strategy 2: Strip leading slash, treat as relative to cwd
  if (originalPath.startsWith("/")) {
    const stripped = originalPath.slice(1);
    
    // If the first component matches cwd basename, skip to Strategy 3 to avoid duplication
    // e.g., "/test/sample.js" with cwd ".../test" → strip gives "test/sample.js" → would create test/test/
    const firstComponent = stripped.split("/")[0];
    if (firstComponent && firstComponent.toLowerCase() === path.basename(absCwd).toLowerCase()) {
      // Skip this strategy, Strategy 3 will handle it correctly
    } else {
      // Normal case: strip leading slash and resolve relative to cwd
      const strippedResolved = pathResolve(absCwd, stripped);
      if (isWithinCwd(strippedResolved, absCwd)) {
        return { resolved: strippedResolved, correction: `Path corrected from ${originalPath} to ${stripped}` };
      }
    }
  }

  // Strategy 3: Strip leading /<basename-of-cwd>/ prefix (repo-name mount style)
  if (originalPath.startsWith("/")) {
    const cwdBasename = path.basename(absCwd);
    const mountPrefix = `/${cwdBasename}/`;
    
    if (originalPath === `/${cwdBasename}` || originalPath.startsWith(mountPrefix)) {
      // Remove the /<repo-name> prefix
      const relativePart = originalPath.slice(mountPrefix.length) || ".";
      const mountResolved = pathResolve(absCwd, relativePart);
      
      if (isWithinCwd(mountResolved, absCwd)) {
        return { resolved: mountResolved, correction: `Path corrected from ${originalPath} to ${relativePart}` };
      }
    }
  }

  // Strategy 4: Try to match any leading path component that equals cwd basename
  const parts = originalPath.split("/").filter(Boolean);
  
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase() === path.basename(absCwd).toLowerCase()) {
      // Found repo-name in the path, strip everything up to and including it
      const remaining = parts.slice(i + 1);
      if (remaining.length > 0) {
        const candidateResolved = pathResolve(absCwd, ...remaining);
        if (isWithinCwd(candidateResolved, absCwd)) {
          return { 
            resolved: candidateResolved, 
            correction: `Path corrected from ${originalPath} to ${path.join(...remaining)}` 
          };
        }
      }
    }
  }

  // No strategy succeeded
  return null;
}

/**
 * Extract <final_answer> block from text using regex.
 * Matches Python's get_final_answer implementation.
 * Note: Uses greedy matching to capture all content between tags.
 */
export function getFinalAnswer(text: string): string {
  // Use greedy matching with DOTALL flag to capture multiline content
  const match = /<final_answer>([\s\S]*)<\/final_answer>/.exec(text);
  if (!match) {
    return text;
  }
  // Return full tag block including <final_answer>...</final_answer>
  return match[0];
}
