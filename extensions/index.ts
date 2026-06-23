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
    max_turns: {
      type: "integer",
      description: "Maximum number of search turns. Default is 15 for thorough exploration.",
      default: 15,
      minimum: 1,
      maximum: 50,
    },
    use_citation: {
      type: "boolean",
      description: "Enable citation mode (output only file paths and line numbers). Default is false for full context with summaries.",
      default: false,
    },
  },
} as const;

// Type for validated tool input (matches the return type of validateInput)
export interface SearchToolInput {
  description: string;
  prompt: string;
  max_turns: number;
  use_citation: boolean;
}

// Timeout for fastcontext execution
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

// pi-fc-search environment variables
const FASTCONTEXT_API_KEY = process.env.FASTCONTEXT_API_KEY || DEFAULT_FASTCONTEXT_API_KEY;
const FASTCONTEXT_ENDPOINT = process.env.FASTCONTEXT_ENDPOINT || DEFAULT_FASTCONTEXT_ENDPOINT;
const FASTCONTEXT_MODEL = process.env.FASTCONTEXT_MODEL || DEFAULT_FASTCONTEXT_MODEL;

// fastcontext CLI expects these environment variable names
// These are only set in child process env to avoid conflicts with other projects
const FC_API_KEY = FASTCONTEXT_API_KEY;
const FC_BASE_URL = FASTCONTEXT_ENDPOINT;
const FC_MODEL = FASTCONTEXT_MODEL;

/**
 * Validates tool input parameters
 */
function validateInput(args: unknown): {
  description: string;
  prompt: string;
  max_turns: number;
  use_citation: boolean;
} {
  if (!args || typeof args !== "object") {
    throw new Error("Invalid tool arguments: expected an object");
  }

  const record = args as Record<string, unknown>;
  const { description, prompt, max_turns, use_citation } = record;

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

  // Validate max_turns with default value
  let parsedMaxTurns: number;
  if (max_turns === undefined || max_turns === null) {
    parsedMaxTurns = 15; // Default for thorough exploration
  } else if (typeof max_turns !== "number" || !Number.isInteger(max_turns)) {
    throw new Error("'max_turns' must be an integer");
  } else if (max_turns < 1 || max_turns > 50) {
    throw new Error("'max_turns' must be between 1 and 50");
  } else {
    parsedMaxTurns = max_turns;
  }

  // Validate use_citation with default value
  let parsedUseCitation: boolean;
  if (use_citation === undefined || use_citation === null) {
    parsedUseCitation = false; // Default: full context with summaries
  } else if (typeof use_citation !== "boolean") {
    throw new Error("'use_citation' must be a boolean");
  } else {
    parsedUseCitation = use_citation;
  }

  return { description, prompt, max_turns: parsedMaxTurns, use_citation: parsedUseCitation };
}

/**
 * Executes fastcontext command and returns results.
 * 
 * This implementation passes arguments directly to the CLI without any processing,
 * and returns the raw stdout output to the agent for interpretation.
 */
function executeFastcontext(
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
  maxTurns: number = 15,
  useCitation: boolean = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Set fastcontext CLI environment variables
    // Use FC_ prefixed variables to avoid conflicts, then map to CLI expected names
    const childEnv = {
      ...process.env,
      API_KEY: FC_API_KEY,
      BASE_URL: FC_BASE_URL,
      MODEL: FC_MODEL,
    };

    // Build command arguments - pass parameters directly to CLI
    const args: string[] = ["-q", prompt];
    args.push("--max-turns", maxTurns.toString());
    if (useCitation) {
      args.push("--citation");
    }

    console.log(`[pi-fc-search] Spawning fastcontext with CWD: ${cwd}`);

    // Create child process without shell for security
    const child: ChildProcess = spawn(
      "fastcontext",
      args,
      {
        cwd,
        env: childEnv,
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

    // Collect stderr and log immediately for debugging
    child.stderr.on("data", (chunk) => {
      const chunkStr = chunk.toString();
      stderrData += chunkStr;
      console.log(`[fastcontext stderr]: ${chunkStr}`);
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
        // Return raw stderr for agent to interpret
        resolve(stderrData || "[ERROR] Subagent execution failed.");
        return;
      }

      // Return raw stdout without any processing or truncation
      // This allows the agent to see <final_answer> tags and explore logs directly
      resolve(stdoutData);
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
        const validated = validateInput(params);
        const { description, prompt, max_turns, use_citation } = validated;

        // Update progress
        onUpdate?.({
          content: [{ type: "text", text: `Searching: ${description}...` }],
        });

        // Convert cwd to absolute path
        const absoluteCwd = path.resolve(ctx.cwd);
        console.log(`[pi-fc-search] Using absolute CWD: ${absoluteCwd}`);

        // Execute fastcontext search with validated parameters
        // Arguments are passed directly to CLI, output is returned raw
        const result = await executeFastcontext(
          prompt,
          absoluteCwd,
          signal,
          max_turns,
          use_citation
        );

        // Return raw CLI output - let the agent interpret it directly
        return {
          content: [{ type: "text", text: result }],
          details: { description, promptLength: prompt.length, max_turns, use_citation },
        };
      } catch (error) {
        if (error.message?.includes("cancelled")) {
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
