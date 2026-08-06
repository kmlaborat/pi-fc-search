/**
 * Glob tool - fast file pattern matching.
 * Ported from src/fastcontext/agent/tool/glob.py
 */

import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { spawn } from "child_process";
import { isWithinCwd, resolveDockerMountPath } from "../utils.js";
import type { Tool, CallContext, ToolResult } from "./types.js";
import { getRgPath } from "./rg.js";

const GLOB_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
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
        // Fall back to standard resolution
        resolvedDirectory = resolve(directory);
      }

      // Validate directory
      if (!existsSync(resolvedDirectory)) {
        return `The directory \`${resolvedDirectory}\` does not exist.`;
      }

      const stat = statSync(resolvedDirectory);
      if (!stat.isDirectory()) {
        return `The directory \`${resolvedDirectory}\` is not a directory.`;
      }

      // Check containment within working directory (SPEC §10)
      if (!isWithinCwd(resolvedDirectory, ctx.cwd)) {
        return `Permission error: \`${resolvedDirectory}\` is not within the working directory \`${ctx.cwd}\`.`;
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
    const rgPath = await getRgPath();

    return new Promise((resolve, reject) => {
      const command = ["--files", directory, "--glob", pattern];
      
      const child = spawn(rgPath, command, { cwd: ctx.cwd, shell: false });
      
      let stdout = "";
      let stderr = "";
      
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      // Timeout handling
      const timeoutHandle = setTimeout(() => {
        child.kill();
        reject(new Error(`Tool timed out after ${RG_TIMEOUT}s`));
      }, RG_TIMEOUT * 1000);

      child.on("close", (code) => {
        clearTimeout(timeoutHandle);

        // ripgrep exits 1 when no files found - this is not an error for us
        if (code === 0 || code === 1) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Ripgrep exited with code ${code}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }
}
