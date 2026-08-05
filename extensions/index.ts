/**
 * pi-fc-search Extension - In-process fastcontext search
 * 
 * Integrates Microsoft's fastcontext tool with pi coding agent using in-process TypeScript agent.
 * No external Python process required.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import { runFastContextAgent, RunFastContextAgentOptions } from "../src/fastcontext-agent/index.js";

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

export interface SearchToolInput {
  description: string;
  prompt: string;
  max_turns: number;
  use_citation: boolean;
}

// Timeout for agent execution
const TIMEOUT_SECONDS = 120;

// ============================================================================
// .env File Loader
// ============================================================================

function loadEnvFile(): void {
  try {
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
    // Log error for debugging but continue - don't crash extension on .env issues
    console.error(`[pi-fc-search] Warning: Failed to load .env files. API key and configuration may not be available.`);
  }
}

// Load environment variables at module initialization
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
    // Handle timeout
    if (controller.signal.reason instanceof Error && 
        controller.signal.reason.message === "timeout") {
      return "[ERROR] pi-fc-search execution timeout exceeded (120 seconds).";
    }
    
    // Handle user cancellation
    if (controller.signal.reason instanceof Error && 
        controller.signal.reason.message === "cancelled") {
      throw new Error("Operation was cancelled");
    }
    
    // Handle AbortError from fetch
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
