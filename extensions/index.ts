/**
 * pi-fc-search Extension - In-process fastcontext search
 * 
 * Integrates Microsoft's fastcontext tool with pi coding agent using in-process TypeScript agent.
 * No external Python process required.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "path";
import { runFastContextAgent, RunFastContextAgentOptions } from "../src/fastcontext-agent/index.js";
import { loadEnvFile } from "../src/fastcontext-agent/env.js";

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
      description: "Detailed natural language instruction or question for repository exploration.",
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

export interface SearchToolInput {
  description: string;
  prompt: string;
  max_turns: number;
  use_citation: boolean;
}

// Timeout for agent execution
const TIMEOUT_SECONDS = 120;

// ============================================================================
// .env Loading
// ============================================================================

// Load environment variables at module initialization (shared, idempotent
// loader in src/fastcontext-agent/env.ts). Must run before the constants
// below are read.
loadEnvFile();

// ============================================================================
// Configuration from .env
// ============================================================================

const FASTCONTEXT_API_KEY = process.env.FASTCONTEXT_API_KEY || "";
const FASTCONTEXT_ENDPOINT = process.env.FASTCONTEXT_ENDPOINT || "";
const FASTCONTEXT_MODEL = process.env.FASTCONTEXT_MODEL || "";

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

  if (typeof description !== "string" || description.length === 0) {
    throw new Error("Missing or invalid 'description' parameter");
  }
  if (description.length > 100) {
    throw new Error("'description' exceeds maximum length of 100 characters");
  }

  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("Missing or invalid 'prompt' parameter");
  }
  if (prompt.length > 2000) {
    throw new Error("'prompt' exceeds maximum length of 2000 characters");
  }

  // Validate max_turns with default value
  let parsedMaxTurns: number;
  if (max_turns === undefined || max_turns === null) {
    parsedMaxTurns = 15;
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
    parsedUseCitation = false;
  } else if (typeof use_citation !== "boolean") {
    throw new Error("'use_citation' must be a boolean");
  } else {
    parsedUseCitation = use_citation;
  }

  return { description, prompt, max_turns: parsedMaxTurns, use_citation: parsedUseCitation };
}

/**
 * Executes fastcontext agent in-process with timeout protection.
 * Uses AbortSignal for both timeout and user cancellation (SPEC §4.10).
 */
async function executeAgent(
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
  maxTurns: number = 15,
  useCitation: boolean = false
): Promise<string> {
  
  // Create controller for timeout/cancellation coordination
  const controller = new AbortController();
  
  // Setup timeout that aborts the controller
  const timeoutId = setTimeout(() => {
    controller.abort(new Error("timeout"));
  }, TIMEOUT_SECONDS * 1000);
  
  // Link user cancellation signal to controller
  if (signal) {
    signal.addEventListener("abort", () => {
      controller.abort(new Error("cancelled"));
    });
  }
  
  // Cleanup on completion or abort
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timeoutId);
  });

  // Fail fast with an actionable message when configuration is missing.
  // Without this, an empty base URL produces a cryptic fetch error after
  // the agent has already burned turns on a dead endpoint.
  if (!FASTCONTEXT_ENDPOINT) {
    return "[ERROR] FASTCONTEXT_ENDPOINT is not configured. Set it in pi-fc-search/.env (see .env.example) or as a shell environment variable.";
  }
  if (!FASTCONTEXT_MODEL) {
    return "[ERROR] FASTCONTEXT_MODEL is not configured. Set it in pi-fc-search/.env (see .env.example) or as a shell environment variable.";
  }

  const options: RunFastContextAgentOptions = {
    prompt,
    cwd,
    maxTurns,
    citation: useCitation,
    signal: controller.signal,
    llm: {
      model: FASTCONTEXT_MODEL || process.env.FASTCONTEXT_MODEL || "",
      apiKey: FASTCONTEXT_API_KEY || process.env.FASTCONTEXT_API_KEY || "",
      baseUrl: FASTCONTEXT_ENDPOINT || process.env.FASTCONTEXT_ENDPOINT || "",
    }
  };

  try {
    return await runFastContextAgent(options);
  } catch (error) {
    // Determine why the abort fired. `AbortSignal.reason` may be an Error,
    // a string, or anything else — normalize it.
    const reason = controller.signal.reason;
    const reasonMessage =
      reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";

    // Handle timeout (covers the fetch AbortError, the agent's per-turn
    // abort check, and any other error raised after the timer fired).
    // Message text is the exact SPEC §6 string — do not append extra prose.
    if (controller.signal.aborted && reasonMessage === "timeout") {
      return "[ERROR] pi-fc-search execution timeout exceeded (120 seconds).";
    }

    // Handle user cancellation
    if (controller.signal.aborted) {
      throw new Error("Operation was cancelled");
    }

    // Handle AbortError from fetch (defensive: no linked controller abort)
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Operation was cancelled");
    }

    // Return raw error for agent to interpret
    return `[ERROR] ${error instanceof Error ? error.message : "Unknown error occurred"}`;
  }
}

/**
 * Main extension factory function
 */
export default function (pi: ExtensionAPI) {
  // Register session start handler
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("pi-fc-search extension loaded (in-process mode)", "info");
  });

  // Register session shutdown handler for cleanup
  pi.on("session_shutdown", async (_event, _ctx) => {
    // Cleanup resources if needed
  });

  // Register the fastcontext search tool
  pi.registerTool({
    name: "fc_search",
    label: "FC Search",
    description: "Search repository using fastcontext to find relevant code locations (in-process)",
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
          content: [{ type: "text", text: `Searching: ${description}...` }]
        });

        // Convert cwd to absolute path
        const absoluteCwd = path.resolve(ctx.cwd);

        // Execute in-process agent (no external spawn required)
        const result = await executeAgent(
          prompt,
          absoluteCwd,
          signal,
          max_turns,
          use_citation
        );

        return {
          content: [{ type: "text", text: result }],
          details: { description, promptLength: prompt.length, max_turns, use_citation }
        };
      } catch (error) {
        if (error instanceof Error && error.message?.includes("cancelled")) {
          // Return non-error response for user cancellation (SPEC §6)
          return {
            content: [{ type: "text", text: "Search was cancelled" }],
            isError: false,
          };
        }
        return {
          content: [{ type: "text", text: `[ERROR] ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    },
  });
}
