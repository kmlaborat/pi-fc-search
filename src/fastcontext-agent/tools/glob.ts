/**
 * Glob tool - fast file pattern matching.
 * Ported from src/fastcontext/agent/tool/glob.py
 */

import { existsSync, statSync } from "fs";
import { realpath } from "fs/promises";
import { resolve } from "path";
import { isWithinCwd, resolveDockerMountPath } from "../utils.js";
import type { Tool, CallContext, ToolResult } from "./types.js";
import { runRipgrep } from "./rg.js";

// (SPEC §19 v3) v2 kept the upstream glob.md text verbatim, which (a) claimed
// results are "sorted by modification time" — upstream never sorted — and
// (b) told the model to "use the Agent tool instead" — a tool that does not
// exist in this toolset; a general model that followed the advice burned a
// turn on `Tool 'Agent' not found.` Both lines are removed; the real
// 100-result cap and filesystem order are stated instead.
const GLOB_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths (up to 100 results, in filesystem order)
- Use this tool when you need to find files by name patterns
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.`;

// Ripgrep timeout (10 seconds)
const RG_TIMEOUT = 10;

export class GlobTool implements Tool {
  name = "Glob";
  description = GLOB_DESCRIPTION;
  
  parameters = {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "The absolute path of the directory to search in. If not provided, the current working directory will be used."
      },
      pattern: {
        type: "string",
        description: "The glob pattern to match files or directories."
      }
    },
    required: ["pattern"]
  };

  schema(): object {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters
      }
    };
  }

  async call(params: string, ctx: CallContext): Promise<string> {
    // Defensive check for cwd - prevents cryptic Node path errors
    if (!ctx.cwd || typeof ctx.cwd !== "string") {
      throw new Error("[FastContext] Internal error: cwd was not provided to Glob tool execution");
    }

    try {
      const parsed = JSON.parse(params) as {
        directory?: string;
        pattern: string;
      };

      const directory = parsed.directory || ctx.cwd;
      const pattern = parsed.pattern;

      // Resolve directory with Docker-mount style correction for FastContext model outputs
      let resolvedDirectory: string;
      let pathCorrection: string | undefined;

      const dockerResolution = resolveDockerMountPath(directory, ctx.cwd);
      if (dockerResolution) {
        resolvedDirectory = dockerResolution.resolved;
        pathCorrection = dockerResolution.correction;
      } else {
        // Fall back to standard resolution.
        // (Review fix) resolve against the tool's working directory, not the
        // Node process cwd (same rationale as the Read tool).
        resolvedDirectory = resolve(ctx.cwd, directory);
      }

      // Check containment within working directory (SPEC §12) BEFORE any
      // filesystem access — the old order leaked existence/typo information
      // for paths outside the working directory and was inconsistent with
      // the Read and Grep tools.
      if (!isWithinCwd(resolvedDirectory, ctx.cwd)) {
        return `Permission error: \`${resolvedDirectory}\` is not within the working directory \`${ctx.cwd}\`.`;
      }

      // (D-022, SPEC §18) Realpath containment: the lexical isWithinCwd check
      // does not see through symlinks; re-check the resolved target so a
      // symlinked directory inside the working directory cannot list files
      // outside it (same defense as the Read tool, D-020). On realpath failure
      // (path does not exist yet) the passed lexical check governs — the
      // existence validation below still applies.
      try {
        const realDir = await realpath(resolvedDirectory);
        const realCwd = await realpath(ctx.cwd);
        if (!isWithinCwd(realDir, realCwd)) {
          return `Permission error: \`${resolvedDirectory}\` (resolves to \`${realDir}\`) is not within the working directory \`${ctx.cwd}\`.`;
        }
      } catch {
        // See note above.
      }

      // Validate directory
      if (!existsSync(resolvedDirectory)) {
        return `The directory \`${resolvedDirectory}\` does not exist.`;
      }

      const stat = statSync(resolvedDirectory);
      if (!stat.isDirectory()) {
        return `The directory \`${resolvedDirectory}\` is not a directory.`;
      }

      const correctionNote = pathCorrection ? `[${pathCorrection}]\n` : "";

      // Run ripgrep with timeout
      const output = await this.runRipgrepSearch(resolvedDirectory, pattern, ctx);

      if (!output || output.trim() === "") {
        return "No files found";
      }

      // Split into lines and limit to 100 matches
      const matchedFiles = output.split("\n").filter(Boolean);
      
      const limit = 100;
      if (matchedFiles.length > limit) {
        const truncated = matchedFiles.slice(0, limit);
        return `${correctionNote}${truncated.join("\n") + `\nResults are truncated: showing first ${limit} results. Consider using a more specific path or pattern.`}`;
      }

      return `${correctionNote}${output.trim()}`;
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) {
        return `Tool \`Glob\` timed out after ${RG_TIMEOUT}s.`;
      }
      return error instanceof Error ? error.message : "Unknown error";
    }
  }

  private async runRipgrepSearch(directory: string, pattern: string, ctx: CallContext): Promise<string> {
    return await runRipgrep(["--files", directory, "--glob", pattern], ctx.cwd, RG_TIMEOUT);
  }
}
