/**
 * Read tool - reads files from filesystem.
 * Ported from src/fastcontext/agent/tool/read.py
 */

// (Review fix) async fs/promises instead of sync fs: a blocking readFileSync
// inside the async tool could not be interrupted by the 10s tool timeout and
// froze the host (pi) event loop on large files.
import { readFile, stat } from "fs/promises";
import { join, resolve } from "path";
import { isWithinCwd, resolveDockerMountPath } from "../utils.js";
import type { Tool, CallContext, ToolResult } from "./types.js";

export const MAX_LINE = 2000;
// The code enforces 2000 chars/line (upstream behavior, SPEC §8.1). The
// tool description now matches the code (SPEC §19 v3); v2 had kept the
// stale upstream "500 characters" prose verbatim.
export const MAX_LINE_LENGTH = 2000;

// Read tool description (verbatim from Python source)
const READ_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive 'File is empty.'
- Any lines longer than 2000 characters will be truncated to 2000 characters with '...' appended to the end. (SPEC §19 v3: the v2 text kept the stale upstream "500" figure; the code has always enforced 2000.)
- Any file content that exceeds the 2000 lines will be truncated to 2000 lines with '...' appended to the end.`;

export class ReadTool implements Tool {
  name = "Read";
  description = READ_DESCRIPTION;
  
  parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The absolute path of the file to read."
      },
      offset: {
        type: "integer",
        description: "The line number to start reading from, 1-indexed from the start of the file. Values below 1 read from the first line. Only provide if the file is too large to read at once."
      },
      limit: {
        type: "integer",
        description: "The number of lines to read. Only provide if the file is too large to read at once."
      }
    },
    required: ["path"]
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
      throw new Error("[FastContext] Internal error: cwd was not provided to Read tool execution");
    }

    try {
      const parsed = JSON.parse(params) as {
        path: string;
        offset?: number;
        limit?: number;
      };
      
      const filePath = parsed.path;
      const offset = parsed.offset;
      const limit = parsed.limit;

      if (!filePath) {
        return "Read Tool: file path is required.";
      }

      // Resolve path with Docker-mount style correction for FastContext model outputs
      const absoluteCwd = ctx.cwd;
      let resolvedPath: string;
      let pathCorrection: string | undefined;

      const dockerResolution = resolveDockerMountPath(filePath, absoluteCwd);
      if (dockerResolution) {
        resolvedPath = dockerResolution.resolved;
        pathCorrection = dockerResolution.correction;
      } else {
        // Fall back to standard resolution
        resolvedPath = resolve(filePath);
      }

      if (!isWithinCwd(resolvedPath, absoluteCwd)) {
        return `Permission error: \`${resolvedPath}\` is not within the working directory \`${absoluteCwd}\`.`;
      }

      let isFile = false;
      try {
        isFile = (await stat(resolvedPath)).isFile();
      } catch {
        // File does not exist
      }
      if (!isFile) {
        return `Read Tool: file ${filePath} does not exist.`;
      }

      // Prepend path correction note if applicable
      const correctionNote = pathCorrection ? `[${pathCorrection}]\n` : "";

      // Read file
      const content = await readFile(resolvedPath, "utf-8");
      
      if (!content || content.trim() === "") {
        return "File is empty.";
      }
      
      const lines = content.split("\n");

      // (Review fix) Validate the paging parameters before computing the
      // range — previously an offset beyond EOF produced a header with zero
      // lines and a non-positive limit produced an empty range.
      if (limit !== undefined && limit <= 0) {
        return "Read Tool: limit must be a positive integer.";
      }

      // Calculate range
      // SPEC §8.1: offset is 1-indexed; if undefined or < 0, treat as 1.
      let startLine = 1;
      if (offset !== undefined && offset > 0) {
        startLine = offset;
      }

      if (startLine > lines.length) {
        return `Read Tool: offset ${offset} exceeds end of file (${lines.length} lines).`;
      }

      let endLine = limit !== undefined ? startLine + limit - 1 : lines.length;
      
      // Clamp to file length
      if (endLine > lines.length) {
        endLine = lines.length;
      }

      // Cap at MAX_LINE
      const totalLinesToRead = endLine - startLine + 1;
      if (totalLinesToRead > MAX_LINE) {
        endLine = startLine + MAX_LINE - 1;
      }

      // Build output with line numbers and prefixes
      const outputLines: string[] = [];
      
      for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
        let line = lines[i];
        
        // Truncate long lines
        if (line.length > MAX_LINE_LENGTH) {
          line = line.slice(0, MAX_LINE_LENGTH) + "...";
        }
        
        outputLines.push(`${i + 1}|${line}`);
      }

      // Add truncation indicator if needed
      if (totalLinesToRead > MAX_LINE) {
        outputLines.push("...");
      }

      const joinedContent = outputLines.join("\n");
      return `${correctionNote}\`\`\`${resolvedPath}:${startLine}-${endLine}\n${joinedContent}\n\`\`\``;
    } catch (error) {
      return `Read Tool error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
  }
}
