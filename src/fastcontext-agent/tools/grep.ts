/**
 * Grep tool - search code with ripgrep.
 * Ported from src/fastcontext/agent/tool/grep.py
 */

import { resolve } from "path";
import { isWithinCwd, resolveDockerMountPath } from "../utils.js";
import { MAX_TOOLRUN_TIMEOUT, type Tool, type CallContext, type ToolResult } from "./types.js";
import { runRipgrep } from "./rg.js";

// Hard safety cap for an explicit head_limit request (D-010, SPEC §18).
// See the limit computation in call() for rationale.
const MAX_GREP_HEAD_LIMIT = 2000;

const GREP_DESCRIPTION = `A powerful search tool built on ripgrep
Usage:
- Prefer using Grep for search tasks when you know the exact symbols or strings to search for. Whenever possible, use this tool instead of invoking grep or rg as a terminal command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., ".js", "**/.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use interface\\{\\} to find interface{} in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like struct \\{[\\s\\S]*?field, use multiline: true
- Results are capped to 100 output lines by default; pass head_limit (up to 2000) to request more. When truncation occurs, the output ends with a "Results truncated to first N lines" note. (SPEC §19 v3: the v2 text claimed "several thousand" lines, contradicting the actual 100/2000 caps.)
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

// Raw parsed arguments interface for JSON.parse result
interface RawGrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: string;
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  "-n"?: boolean;
  "-i"?: boolean;
  type?: string;
  head_limit?: number;
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
        minimum: 1,
        // (D-017, SPEC §18) minimum moved from 0 to 1: 0 (and negative
        // values) are now rejected with an actionable message instead of
        // being silently remapped to the default 100.
        description: 'Limit output to first N lines/entries (positive integer, max 2000), equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). When unspecified, the first 100 lines are shown.'
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
    // Defensive check for cwd - prevents cryptic Node path errors
    if (!ctx.cwd || typeof ctx.cwd !== "string") {
      throw new Error("[FastContext] Internal error: cwd was not provided to Grep tool execution");
    }

    try {
      const parsed = JSON.parse(params) as RawGrepArgs;
      
      // Apply defaults
      const rgArgs: RipgrepArgs = {
        pattern: parsed.pattern,
        path: parsed.path || ctx.cwd,
        glob: parsed.glob,
        outputMode: (parsed.output_mode as RipgrepArgs["outputMode"]) || "content",
        beforeContext: parsed["-B"],
        afterContext: parsed["-A"],
        // (D-013, SPEC §18): `||` coerced an explicit `-C: 0` (no context) to
        // the default 3. `??` honors 0; the default applies only when the
        // parameter is absent (undefined).
        context: parsed["-C"] ?? 3,
        lineNumbers: parsed["-n"] ?? true,
        ignoreCase: parsed["-i"] || false,
        typeFilter: parsed.type,
        headLimit: parsed.head_limit,
        multiline: parsed.multiline || false
      };

      // (D-017, SPEC §18) Reject head_limit <= 0 with an actionable message
      // instead of silently remapping it to the default 100. The old `> 0`
      // guard in the limit computation below reintroduced, for the degenerate
      // value 0, exactly the silent-remapping failure mode D-010 removed for
      // values >= 100: a model requesting 0 (most plausibly "no limit")
      // received 100 with no explanation. Naming the two valid options lets
      // the model self-correct in one turn. Validated before spawning rg.
      if (rgArgs.headLimit !== undefined && rgArgs.headLimit <= 0) {
        return "Grep Tool: head_limit must be a positive integer. Omit head_limit for the default (100 lines), or use a value up to 2000.";
      }

      // Resolve path with Docker-mount style correction for FastContext model outputs
      let resolvedPath: string;
      let pathCorrection: string | undefined;

      const dockerResolution = resolveDockerMountPath(rgArgs.path || ctx.cwd, ctx.cwd);
      if (dockerResolution) {
        resolvedPath = dockerResolution.resolved;
        pathCorrection = dockerResolution.correction;
      } else {
        // Fall back to standard resolution
        resolvedPath = resolve(rgArgs.path!);
      }

      // Validate path containment (SPEC §12) - after correction
      if (!isWithinCwd(resolvedPath, ctx.cwd)) {
        return `Permission error: \`${resolvedPath}\` is not within the working directory \`${ctx.cwd}\`.`;
      }

      const correctionNote = pathCorrection ? `[${pathCorrection}]\n` : "";

      // Build and execute ripgrep command (use corrected path)
      rgArgs.path = resolvedPath;
      const output = await this.runRipgrepCommand(rgArgs, ctx);

      if (!output || output.trim() === "") {
        return "No matches found";
      }

      // Apply line limit.
      // (D-010, SPEC §18) Upstream only honored head_limit when
      // 0 < head_limit < 100, silently clamping larger explicit requests back
      // to the default 100 — contradicting the frozen schema description,
      // which promises head_limit behaves like `| head -N`. Positive
      // head_limit values are now honored, capped at MAX_GREP_HEAD_LIMIT to
      // protect the sub-agent's context window (matches the Read tool's
      // 2000-line MAX_LINE). Default (unspecified) remains 100.
      let limit = 100;
      if (rgArgs.headLimit !== undefined && rgArgs.headLimit > 0) {
        limit = Math.min(rgArgs.headLimit, MAX_GREP_HEAD_LIMIT);
      }

      const lines = output.split("\n");
      if (lines.length > limit) {
        const truncatedLines = lines.slice(0, limit);
        return `${correctionNote}${truncatedLines.join("\n") + `\nResults truncated to first ${limit} lines`}`;
      }

      return `${correctionNote}${output.trim()}`;
    } catch (error) {
      return error instanceof Error ? error.message : "Unknown error";
    }
  }

  private async runRipgrepCommand(rgArgs: RipgrepArgs, ctx: CallContext): Promise<string> {
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

    // Handle output modes
    // NOTE: Upstream quirk preserved - schema enum has "count" but Python code uses "count_matches"
    // The agent may send either value; both map to --count-matches flag
    const outputMode = rgArgs.outputMode || "content";
    
    if (outputMode === "content") {
      if (rgArgs.beforeContext) command.push("-B", String(rgArgs.beforeContext));
      if (rgArgs.afterContext) command.push("-A", String(rgArgs.afterContext));
      if (rgArgs.context) command.push("-C", String(rgArgs.context));
      if (rgArgs.lineNumbers) command.push("-n");
    } else if (outputMode === "files_with_matches") {
      command.push("--files-with-matches");
    } else if (outputMode === "count" || outputMode === "count_matches" as any) {
      command.push("--count-matches");
    }

    // Always add --heading --color never
    command.push("--heading", "--color", "never");

    try {
      return await runRipgrep(command, ctx.cwd, MAX_TOOLRUN_TIMEOUT);
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : "Unknown error";

      // SPEC §8.4: timeout results must read `Tool \`Grep\` timed out after 10s.`
      if (errorMessage.includes("timed out")) {
        throw new Error(`Tool \`Grep\` timed out after ${MAX_TOOLRUN_TIMEOUT}s.`);
      }

      // Add helpful hint for regex parse errors to help the model adjust its strategy
      if (errorMessage.includes("regex parse error")) {
        errorMessage += `\n\n[Hint] The regex pattern may be malformed. Try a simpler pattern without complex grouping or anchors. For example, use "interface" instead of "\\b(\\w+?)\\s+Interface\\{"`;
      }

      throw new Error(errorMessage);
    }
  }
}
