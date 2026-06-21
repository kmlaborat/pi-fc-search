/**
 * pi-fc-search Extension
 * 
 * Integrates Microsoft's fastcontext repository search tool with pi coding agent.
 * Allows the LLM to search large codebases efficiently without consuming excessive context tokens.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Tool input schema (JSON Schema format - zero external dependencies)
const SearchToolSchema = {
  type: "object",
  required: ["description", "prompt"],
  properties: {
    description: {
      type: "string",
      description: "Short task description (3-5 words, e.g., 'Find API auth middleware')",
      maxLength: 100,
    },
    prompt: {
      type: "string",
      description: "Detailed natural language instruction or question for repository search",
      maxLength: 2000,
    },
  },
} as const;

export type SearchToolInput = typeof SearchToolSchema;

// Truncation limits
const MAX_LINES = 2000;
const MAX_BYTES = 50000;
const TIMEOUT_SECONDS = 120;

// ============================================================================
// .env File Loader
// ============================================================================

function loadEnvFile(): void {
  try {
    // Try to find .env file in package directory
    const possiblePaths = [
      path.join(process.cwd(), '.env'),
      path.join(__dirname, '..', '.env'),
      path.join(__dirname, '.env'),
    ];

    for (const envPath of possiblePaths) {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const lines = content.split('\n');
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex === -1) continue;
          
          const key = trimmed.substring(0, eqIndex).trim();
          let value = trimmed.substring(eqIndex + 1).trim();
          
          // Remove surrounding quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          
          process.env[key] = value;
        }
        
        return; // Found and loaded .env file
      }
    }
  } catch (error) {
    // Silently fail - environment variables might be set externally
    console.log(`[pi-fc-search] Warning: Could not load .env file: ${error}`);
  }
}

// Load environment variables from .env file at module initialization
loadEnvFile();

// ============================================================================
// Configuration from .env
// ============================================================================

const DEFAULT_FASTCONTEXT_API_KEY = "";
const DEFAULT_FASTCONTEXT_ENDPOINT = "";
const DEFAULT_FASTCONTEXT_MODEL = "";

const FASTCONTEXT_API_KEY = process.env.FASTCONTEXT_API_KEY || DEFAULT_FASTCONTEXT_API_KEY;
const FASTCONTEXT_ENDPOINT = process.env.FASTCONTEXT_ENDPOINT || DEFAULT_FASTCONTEXT_ENDPOINT;
const FASTCONTEXT_MODEL = process.env.FASTCONTEXT_MODEL || DEFAULT_FASTCONTEXT_MODEL;

/**
 * Validates tool input parameters
 */
/**
 * Validates tool input parameters
 */
function validateInput(args: unknown): { description: string; prompt: string } {
  if (!args || typeof args !== "object") {
    throw new Error("Invalid tool arguments: expected an object");
  }

  const { description, prompt } = args as Record<string, unknown>;

  if (typeof description !== "string") {
    throw new Error("Missing or invalid 'description' parameter: must be a string");
  }
  if (description.length === 0) {
    throw new Error("'description' cannot be empty");
  }
  if (description.length > 100) {
    throw new Error("'description' exceeds maximum length of 100 characters");
  }

  if (typeof prompt !== "string") {
    throw new Error("Missing or invalid 'prompt' parameter: must be a string");
  }
  if (prompt.length === 0) {
    throw new Error("'prompt' cannot be empty");
  }
  if (prompt.length > 2000) {
    throw new Error("'prompt' exceeds maximum length of 2000 characters");
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
 * Converts fastcontext output to SPEC-compliant Markdown format
 */
function formatToSpec(output: string): string {
  // Parse fastcontext output and format according to SPEC Section 3.1
  // Expected fastcontext output format: file:line:content or similar
  
  const lines = output.split("\n");
  const relevantLocations: Array<{ file: string; start: number; end: number }> = [];
  let summaryLines: string[] = [];

  for (const line of lines) {
    // Try to parse citation format: path/to/file.ts:line: content
    const citationMatch = line.match(/^(.+?):(\d+):\s*(.*)$/);
    if (citationMatch) {
      const [, file, lineStr, content] = citationMatch;
      const lineNumber = parseInt(lineStr, 10);
      if (!isNaN(lineNumber)) {
        relevantLocations.push({ file: file.trim(), start: lineNumber, end: lineNumber });
        if (content.trim()) {
          summaryLines.push(content.trim());
        }
      }
    } else if (line.trim()) {
      // Non-citation lines might be summary content
      summaryLines.push(line);
    }
  }

  // Build SPEC-compliant output
  const formattedLines: string[] = [];
  
  // Summary section
  formattedLines.push("### Summary");
  if (summaryLines.length > 0) {
    // Remove duplicates and limit summary
    const uniqueSummaries = [...new Set(summaryLines)].slice(0, 10);
    formattedLines.push(uniqueSummaries.join(" "));
  } else {
    formattedLines.push("Search completed successfully.");
  }
  formattedLines.push("");

  // Relevant Locations section
  formattedLines.push("### Relevant Locations");
  if (relevantLocations.length > 0) {
    // Remove duplicates
    const uniqueLocations = Array.from(
      new Set(relevantLocations.map(loc => `${loc.file}:${loc.start}-${loc.end}`))
    );
    
    for (const locStr of uniqueLocations.slice(0, 20)) {
      const [file, range] = locStr.split(":");
      formattedLines.push(`- **[${file}]**: lines [${range}]`);
    }
  } else {
    formattedLines.push("No specific locations identified.");
  }

  return formattedLines.join("\n");
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
          resolve("[ERROR] fastcontext command not found. Ensure the package is properly installed and available in PATH.");
          return;
        }
        resolve("[ERROR] Subagent execution failed due to upstream LLM API error.");
        return;
      }

      // Check for no matching code found
      if (!stdoutData.trim() || stdoutData.trim().length === 0) {
        resolve(`### Summary\n\nNo relevant files or contexts found matching the query.`);
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
        // Environment variables from .env are automatically passed to child process
        const result = await executeFastcontext(
          prompt,
          ctx.cwd,
          signal
        );

        // Format output to SPEC-compliant Markdown format
        const formattedResult = formatToSpec(result);

        return {
          content: [{ type: "text", text: formattedResult }],
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
