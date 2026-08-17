/**
 * Read tool - reads files from filesystem.
 * Ported from src/fastcontext/agent/tool/read.py
 */

// (Review fix) async fs/promises instead of sync fs: a blocking readFileSync
// inside the async tool could not be interrupted by the 10s tool timeout and
// froze the host (pi) event loop on large files.
import { readFile, stat, open, realpath } from "fs/promises";
import { join, resolve } from "path";
import { isWithinCwd, resolveDockerMountPath } from "../utils.js";
import type { Tool, CallContext, ToolResult } from "./types.js";

export const MAX_LINE = 2000;
// The code enforces 2000 chars/line (upstream behavior, SPEC §8.1). The
// tool description now matches the code (SPEC §19 v3); v2 had kept the
// stale upstream "500 characters" prose verbatim.
export const MAX_LINE_LENGTH = 2000;

// (D-020, SPEC §18) Whole-file read is required for in-memory paging, so
// files above this cap are refused instead of loading multi-GB artifacts
// (minified bundles, logs, datasets) into memory and stalling the host
// event loop. Grep is the right tool for large files.
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
// (D-020, SPEC §18) NUL-byte probe window for binary detection.
const BINARY_PROBE_BYTES = 8192;

// Read tool description (verbatim from Python source)
const READ_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive 'File is empty.'
- Any lines longer than 2000 characters will be truncated to 2000 characters with '...' appended to the end. (SPEC §19 v3: the v2 text kept the stale upstream "500" figure; the code has always enforced 2000.)
- Any file content that exceeds the 2000 lines will be truncated to 2000 lines with '...' appended to the end.
- Files larger than 10 MB or binary files are rejected; use Grep to search them instead.`;

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
        // Fall back to standard resolution.
        // (Review fix) resolve against the tool's working directory, not
        // the Node process cwd — the containment check below still catches
        // escapes, but process.cwd() gave confusing resolution results when
        // pi runs from a different directory than the searched repo.
        resolvedPath = resolve(absoluteCwd, filePath);
      }

      if (!isWithinCwd(resolvedPath, absoluteCwd)) {
        return `Permission error: \`${resolvedPath}\` is not within the working directory \`${absoluteCwd}\`.`;
      }

      let fileStat;
      try {
        fileStat = await stat(resolvedPath);
      } catch {
        // File does not exist
      }
      if (!fileStat || !fileStat.isFile()) {
        return `Read Tool: file ${filePath} does not exist.`;
      }

      // (D-020, SPEC §18) Refuse oversized files BEFORE loading them:
      // readFile pulls the whole file into memory (paging happens in
      // memory), so a multi-GB artifact would stall the host event loop.
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        return `Read Tool: file ${filePath} is too large (${fileStat.size} bytes; limit ${MAX_FILE_SIZE_BYTES}). Use Grep to search it instead.`;
      }

      // (D-020, SPEC §18) Binary detection: probing the first bytes for NUL
      // avoids decoding megabytes of binary data as UTF-8 garbage.
      {
        const probeHandle = await open(resolvedPath, "r");
        try {
          const probe = Buffer.alloc(BINARY_PROBE_BYTES);
          const { bytesRead } = await probeHandle.read(probe, 0, BINARY_PROBE_BYTES, 0);
          if (probe.subarray(0, bytesRead).includes(0)) {
            return `Read Tool: file ${filePath} appears to be a binary file.`;
          }
        } finally {
          await probeHandle.close();
        }
      }

      // (D-020, SPEC §18) Realpath containment: the lexical isWithinCwd
      // check does not see through symlinks; re-check the resolved target
      // so a symlink inside the working directory cannot read files
      // outside it. On failure (file replaced mid-flight) the lexical
      // check above already passed — continue.
      try {
        const realPath = await realpath(resolvedPath);
        const realCwd = await realpath(absoluteCwd);
        if (!isWithinCwd(realPath, realCwd)) {
          return `Permission error: \`${resolvedPath}\` (resolves to \`${realPath}\`) is not within the working directory \`${absoluteCwd}\`.`;
        }
      } catch {
        // See note above.
      }

      // Prepend path correction note if applicable
      const correctionNote = pathCorrection ? `[${pathCorrection}]\n` : "";

      // Read file
      const content = await readFile(resolvedPath, "utf-8");
      
      if (!content || content.trim() === "") {
        return "File is empty.";
      }
      
      // Normalize CRLF so Windows line endings do not leave a stray \r at the
      // end of every numbered line (matches the LF normalization applied to
      // the system prompt template in prompt.ts).
      const lines = content.replace(/\r\n/g, "\n").split("\n");

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
