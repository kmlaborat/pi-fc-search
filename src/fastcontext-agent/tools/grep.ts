/**
 * Grep tool - search code with ripgrep.
 * Ported from src/fastcontext/agent/tool/grep.py
 */

import { resolve } from "path";
import { spawn } from "child_process";
import { isWithinCwd } from "../utils.js";
import type { Tool, CallContext, ToolResult } from "./types.js";

const GREP_DESCRIPTION = `A powerful search tool built on ripgrep
Usage:
- Prefer using Grep for search tasks when you know the exact symbols or strings to search for. Whenever possible, use this tool instead of invoking grep or rg as a terminal command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., ".js", "**/.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use interface\\{\\} to find interface{} in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like struct \\{[\\s\\S]*?field, use multiline: true
- Results are capped to several thousand output lines for responsiveness; when truncation occurs, the results report "at least" counts, but are otherwise accurate.
- Content output formatting closely follows ripgrep output format: '-' for context lines, ':' for match lines, and all context/match lines below each file group.`;

// Ripgrep arguments interface
interface RipgrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  outputMode?: "content" | "files_with_matches" | "count";
  beforeContext?: number;
  afterContext?: number;
  context?: number;
  lineNumbers?: boolean;
  ignoreCase?: boolean;
  typeFilter?: string;
  headLimit?: number;
  multiline?: boolean;
}

export class GrepTool implements Tool {
  name = "Grep";
  description = GREP_DESCRIPTION;
  
  parameters = {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The regular expression pattern to search for in file contents"
      },
      path: {
        type: "string",
        description: "File or directory to search in (rg pattern -- PATH). Defaults to current working directory."
      },
      glob: {
        type: "string",
        description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: 'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "content".'
      },
      "-B": {
        type: "number",
        description: 'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.'
      },
      "-A": {
        type: "number",
        description: 'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.'
      },
      "-C": {
        type: "number",
        description: 'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise. Defaults to 3.'
      },
      "-n": {
        type: "boolean",
        description: 'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.'
      },
      "-i": {
        type: "boolean",
        description: "Case insensitive search (rg -i)"
      },
      type: {
        type: "string",
        description: "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types."
      },
      head_limit: {
        type: "number",
        minimum: 0,
        description: 'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). When unspecified, shows all results from ripgrep.'
      },
      multiline: {
        type: "boolean",
        description: "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false."
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
    try {
      const parsed = JSON.parse(params) as RipgrepArgs & { output_mode?: string; "-B"?: number; "-A"?: number; "-C"?: number; type?: string };
      
      // Apply defaults
      const rgArgs: RipgrepArgs = {
        pattern: parsed.pattern,
        path: parsed.path || ctx.cwd,
        glob: parsed.glob,
        outputMode: (parsed.output_mode as RipgrepArgs["outputMode"]) || "content",
        beforeContext: parsed["-B"],
        afterContext: parsed["-A"],
        context: parsed["-C"] || 3,
        lineNumbers: parsed["-n"] ?? true,
        ignoreCase: parsed["-i"] || false,
        typeFilter: parsed.type,
        headLimit: parsed.head_limit,
        multiline: parsed.multiline || false
      };

      // Validate path containment (SPEC §10)
      if (!isWithinCwd(resolve(rgArgs.path!), ctx.cwd)) {
        return `Permission error: \`${rgArgs.path}\` is not within the working directory \`${ctx.cwd}\`.`;
      }

      // Build and execute ripgrep command
      const output = await this.runRipgrepCommand(rgArgs, ctx);

      if (!output || output.trim() === "") {
        return "No matches found";
      }

      // Apply line limit (100 or custom head_limit)
      let limit = 100;
      if (rgArgs.headLimit !== undefined && rgArgs.headLimit > 0 && rgArgs.headLimit < limit) {
        limit = rgArgs.headLimit;
      }

      const lines = output.split("\n");
      if (lines.length > limit) {
        const truncatedLines = lines.slice(0, limit);
        return truncatedLines.join("\n") + `\nResults truncated to first ${limit} lines`;
      }

      return output.trim();
    } catch (error) {
      return error instanceof Error ? error.message : "Unknown error";
    }
  }

  private async runRipgrepCommand(rgArgs: RipgrepArgs, ctx: CallContext): Promise<string> {
    let rgPath = process.env.RIPGREP_PATH;
    
    if (!rgPath) {
      try {
        const rgModule = await import("@vscode/ripgrep");
        rgPath = rgModule.rgPath;
      } catch {
        throw new Error("Could not find ripgrep binary. Ensure @vscode/ripgrep is installed.");
      }
    }

    if (!rgPath) {
      throw new Error("Ripgrep not found. Install @vscode/ripgrep or set RIPGREP_PATH environment variable.");
    }

    // Build command arguments (following Python implementation exactly)
    const command = [rgArgs.pattern];
    
    if (rgArgs.path) {
      command.push(rgArgs.path);
    }
    
    if (rgArgs.glob) {
      command.push("--glob", rgArgs.glob);
    }
    
    if (rgArgs.ignoreCase) {
      command.push("--ignore-case");
    }
    
    if (rgArgs.typeFilter) {
      command.push("--type", rgArgs.typeFilter);
    }
    
    if (rgArgs.multiline) {
      command.push("--multiline", "--multiline-dotall");
    }

    // Handle output modes - NOTE: preserve upstream quirk with "count_matches" 
    // Python code uses "count_matches" internally despite schema saying "count"
    const effectiveMode = rgArgs.outputMode === "content" ? "content" : rgArgs.outputMode || "files_with_matches";
    
    if (effectiveMode === "content") {
      if (rgArgs.beforeContext) command.push("-B", String(rgArgs.beforeContext));
      if (rgArgs.afterContext) command.push("-A", String(rgArgs.afterContext));
      if (rgArgs.context) command.push("-C", String(rgArgs.context));
      if (rgArgs.lineNumbers) command.push("-n");
    } else if (effectiveMode === "files_with_matches") {
      command.push("--files-with-matches");
    } else if (effectiveMode === "count_matches" || effectiveMode === "count") {
      // Support both variants for backwards compatibility
      command.push("--count-matches");
    }

    // Always add --heading --color never
    command.push("--heading", "--color", "never");

    return new Promise((resolve, reject) => {
      const child = spawn(rgPath, command, { cwd: ctx.cwd, shell: false });
      
      let stdout = "";
      let stderr = "";
      
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      // Timeout handling (10 seconds)
      const timeoutHandle = setTimeout(() => {
        child.kill();
        reject(new Error("Tool timed out after 10s"));
      }, 10 * 1000);

      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        
        if (code === 0 || code === 1) {
          // ripgrep exits with 1 when no matches found, which is not an error for us
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
