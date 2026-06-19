/**
 * pi-fc-search Extension
 * 
 * Integrates Microsoft's fastcontext repository search tool with pi coding agent.
 * Allows the LLM to search large codebases efficiently without consuming excessive context tokens.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";

// Tool input schema
const SearchToolSchema = Type.Object({
  description: Type.String({
    description: "Short task description (3-5 words, e.g., 'Find API auth middleware')",
  }),
  prompt: Type.String({
    description: "Detailed natural language instruction or question for repository search",
  }),
});

export type SearchToolInput = typeof SearchToolSchema;

// Truncation limits
const MAX_LINES = 2000;
const MAX_BYTES = 50000;
const TIMEOUT_SECONDS = 120;

/**
 * Validates tool input parameters
 */
function validateInput(args: unknown): { description: string; prompt: string } {
  if (!args || typeof args !== "object") {
    throw new Error("Invalid tool arguments");
  }

  const { description, prompt } = args as Record<string, unknown>;

  if (typeof description !== "string" || description.length > 100) {
    throw new Error("Invalid or missing description");
  }

  if (typeof prompt !== "string" || prompt.length > 2000) {
    throw new Error("Invalid or missing prompt");
  }

  return { description, prompt };
}

/**
 * Smart truncation for output
 * Preserves complete lines and code blocks
 */
function truncateOutput(
  content: string,
  totalLines: number,
  totalBytes: number
): string {
  const lines = content.split("\n");
  
  if (lines.length <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return content;
  }

  // Find the last complete line within limits
  let truncatedLines: string[] = [];
  let currentBytes = 0;
  
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + "\n", "utf8");
    if (truncatedLines.length >= MAX_LINES || currentBytes + lineBytes > MAX_BYTES) {
      break;
    }
    truncatedLines.push(line);
    currentBytes += lineBytes;
  }

  // Check for unclosed code blocks
  const truncatedContent = truncatedLines.join("\n");
  const codeBlockMarkers = truncatedContent.match(/```/g) || [];
  
  // If odd number of markers, close the block
  if (codeBlockMarkers.length % 2 !== 0) {
    truncatedLines.push("```");
  }

  // Append truncation notice
  truncatedLines.push(
    `\n[Output truncated: ${truncatedLines.length}/${totalLines} lines (${currentBytes}B/${totalBytes}B).]`
  );

  return truncatedLines.join("\n");
}

/**
 * Executes fastcontext command and returns results
 */
function executeFastcontext(
  prompt: string,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Create child process without shell for security
    const child: ChildProcess = spawn(
      "fastcontext",
      ["-q", prompt, "--citation"],
      {
        cwd,
        env: process.env,
        shell: false,
      }
    );

    let stdoutData = "";
    let stderrData = "";
    let isResolved = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    // Setup timeout
    timeoutHandle = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        child.kill("SIGKILL");
        resolve("[ERROR] pi-fc-search execution timeout exceeded (120 seconds).");
      }
    }, TIMEOUT_SECONDS * 1000);

    // Handle abort signal
    const abortHandler = () => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandle);
        child.kill();
        reject(new Error("Operation was cancelled"));
      }
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    // Collect stdout
    child.stdout.on("data", (chunk) => {
      stdoutData += chunk;
    });

    // Collect stderr
    child.stderr.on("data", (chunk) => {
      stderrData += chunk;
    });

    // Handle process completion
    child.on("close", (code) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", abortHandler);

      if (code !== 0) {
        if (stderrData.includes("not found") || stderrData.includes("ENOENT")) {
          resolve("[ERROR] fastcontext command not found. Ensure the package is properly initialized.");
          return;
        }
        resolve("[ERROR] Subagent execution failed due to upstream LLM API error.");
        return;
      }

      // Apply smart truncation
      const totalLines = stdoutData.split("\n").length;
      const totalBytes = Buffer.byteLength(stdoutData, "utf8");
      const result = truncateOutput(stdoutData, totalLines, totalBytes);
      resolve(result);
    });

    // Handle process errors
    child.on("error", (err) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", abortHandler);
      reject(err);
    });
  });
}

/**
 * Main extension factory function
 */
export default function (pi: ExtensionAPI) {
  // Register session start handler
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("pi-fc-search extension loaded", "info");
  });

  // Register session shutdown handler for cleanup
  pi.on("session_shutdown", async (_event, _ctx) => {
    // Cleanup resources here if needed
  });

  // Register the fastcontext search tool
  pi.registerTool({
    name: "fc_search",
    label: "FC Search",
    description: "Search repository using fastcontext to find relevant code locations",
    promptSnippet: "Search codebase with natural language queries",
    promptGuidelines: [
      "Use fc_search when you need to find code patterns, understand architecture, or locate specific functionality in large codebases",
    ],
    parameters: SearchToolSchema,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate,
      ctx
    ) {
      try {
        const { description, prompt } = validateInput(params);

        // Update progress
        onUpdate?.({
          content: [{ type: "text", text: `Searching: ${description}...` }],
        });

        // Execute fastcontext search
        const result = await executeFastcontext(
          prompt,
          ctx.cwd,
          signal
        );

        return {
          content: [{ type: "text", text: result }],
          details: { description, promptLength: prompt.length },
        };
      } catch (error) {
        if (error.message.includes("cancelled")) {
          return {
            content: [{ type: "text", text: "Search was cancelled" }],
            isError: false,
          };
        }
        return {
          content: [{ type: "text", text: `[ERROR] ${error.message}` }],
          isError: true,
        };
      }
    },
  });
}
