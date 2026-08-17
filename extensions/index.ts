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
import { loadFastContextConfig, validateEndpointUrl } from "../src/fastcontext-agent/config.js";
import type { FastContextEnvConfig } from "../src/fastcontext-agent/config.js";
import { CancelledError, ConfigurationError, TimeoutError } from "../src/fastcontext-agent/errors.js";

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

// ============================================================================
// .env Loading
// ============================================================================

// Load environment variables at module initialization (shared, idempotent
// loader in src/fastcontext-agent/env.ts). Must run before the config below
// is read.
loadEnvFile();

// ============================================================================
// Configuration from .env / shell environment (SPEC §15, §19 v3)
// ============================================================================

const FC_CONFIG: FastContextEnvConfig = loadFastContextConfig();

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
  useCitation: boolean = false,
  onTurn?: (n: number, maxTurns: number) => void
): Promise<string> {
  
  // Fail fast with an actionable message when configuration is missing —
  // BEFORE the timeout timer is scheduled so a config error does not leave a
  // pending timer. Without this check, an empty base URL produces a cryptic
  // fetch error after the agent has already burned turns on a dead endpoint.
  // (D-019, SPEC §18) thrown as a typed error so the tool result is flagged
  // isError: true instead of masquerading as a successful (error-text) answer.
  if (!FC_CONFIG.baseUrl) {
    throw new ConfigurationError(
      "FASTCONTEXT_ENDPOINT is not configured. Set it in pi-fc-search/.env (see .env.example) or as a shell environment variable."
    );
  }
  // (D-026, SPEC §18) Fail fast on an endpoint that is not an absolute
  // http(s) URL: otherwise fetch throws a parse TypeError on every attempt
  // and the D-023 retry loop misreports it as a transient network failure
  // after two wasted retries and backoffs.
  const endpointUrlError = validateEndpointUrl(FC_CONFIG.baseUrl);
  if (endpointUrlError) {
    throw new ConfigurationError(
      `${endpointUrlError} Set it in pi-fc-search/.env (see .env.example) or as a shell environment variable.`
    );
  }
  if (!FC_CONFIG.model) {
    throw new ConfigurationError(
      "FASTCONTEXT_MODEL is not configured. Set it in pi-fc-search/.env (see .env.example) or as a shell environment variable."
    );
  }

  // Create controller for timeout/cancellation coordination
  const controller = new AbortController();
  
  // Setup timeout that aborts the controller (SPEC §19: configurable via
  // FASTCONTEXT_TIMEOUT_SECONDS — CPU-served local models need far more
  // than the historical 120s default).
  const timeoutId = setTimeout(() => {
    controller.abort(new Error("timeout"));
  }, FC_CONFIG.timeoutSeconds * 1000);
  
  // Link user cancellation signal to controller. The listener is removed on
  // completion so repeated calls do not accumulate handlers on the caller's
  // signal.
  const onCallerAbort = () => controller.abort(new Error("cancelled"));
  if (signal) {
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  // Cleanup on completion or abort
  const onControllerAbort = () => {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
  };
  controller.signal.addEventListener("abort", onControllerAbort, { once: true });

  // Resolved from .env + process.env at module load (SPEC §15); fail-fast
  // checks above guarantee endpoint and model are set.
  const options: RunFastContextAgentOptions = {
    prompt,
    cwd,
    maxTurns,
    citation: useCitation,
    signal: controller.signal,
    onTurn,
    llm: {
      model: FC_CONFIG.model,
      apiKey: FC_CONFIG.apiKey,
      baseUrl: FC_CONFIG.baseUrl,
      temperature: FC_CONFIG.temperature,
      maxTokens: FC_CONFIG.maxTokens,
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
    // (SPEC §19 v3) the message reports the configured timeout instead of
    // the historical hard-coded 120s. (D-019, SPEC §18): thrown as a typed
    // error so the tool result is flagged isError: true.
    if (controller.signal.aborted && reasonMessage === "timeout") {
      throw new TimeoutError(
        `pi-fc-search execution timeout exceeded (${FC_CONFIG.timeoutSeconds} seconds).`
      );
    }

    // Handle user cancellation. (D-014, SPEC §18): typed CancelledError
    // instead of a plain Error whose message the caller matched as a string.
    if (controller.signal.aborted) {
      throw new CancelledError();
    }

    // Handle AbortError from fetch (defensive: no linked controller abort)
    if (error instanceof Error && error.name === "AbortError") {
      throw new CancelledError();
    }

    // (D-019, SPEC §18) re-throw so the tool result is flagged isError: true
    // instead of returning an "[ERROR] ..." string as a successful answer.
    // The caller (execute) wraps the message.
    throw error;
  } finally {
    // Release the timeout timer and all signal listeners on every path —
    // previously the 120s (or configured) timer and the caller-signal
    // listener stayed pending after a successful search.
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
    controller.signal.removeEventListener("abort", onControllerAbort);
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
      // AgentToolResult (and the onUpdate partial-result type) require the
      // `details` field on every return path — provide it uniformly.
      const details = (
        d?: string,
        promptLength?: number,
        maxTurns?: number,
        useCitation?: boolean
      ) => ({ description: d, promptLength, max_turns: maxTurns, use_citation: useCitation });

      // Keep whatever search metadata was already validated so error results
      // carry it too (easier host-side diagnostics than empty details).
      let meta: {
        description?: string;
        promptLength?: number;
        maxTurns?: number;
        useCitation?: boolean;
      } = {};

      try {
        const validated = validateInput(params);
        const { description, prompt, max_turns, use_citation } = validated;
        meta = {
          description,
          promptLength: prompt.length,
          maxTurns: max_turns,
          useCitation: use_citation,
        };

        const report = (text: string) => {
          onUpdate?.({
            content: [{ type: "text", text }],
            details: details(description, prompt.length, max_turns, use_citation),
          });
        };

        // Update progress (initial, then per agent turn)
        report(`Searching: ${description}...`);

        // Convert cwd to absolute path
        const absoluteCwd = path.resolve(ctx.cwd);

        // Execute in-process agent (no external spawn required)
        const result = await executeAgent(
          prompt,
          absoluteCwd,
          signal,
          max_turns,
          use_citation,
          (n, max) => report(`Searching: ${description}... (turn ${n}/${max})`)
        );

        return {
          content: [{ type: "text", text: result }],
          details: details(description, prompt.length, max_turns, use_citation)
        };
      } catch (error) {
        // (D-014, SPEC §18): cancellation is identified by type, not by
        // matching the error message string.
        if (
          error instanceof CancelledError ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          // Return non-error response for user cancellation (SPEC §6)
          return {
            content: [{ type: "text", text: "Search was cancelled" }],
            details: details(meta.description, meta.promptLength, meta.maxTurns, meta.useCitation),
            isError: false,
          };
        }
        return {
          content: [{ type: "text", text: `[ERROR] ${error instanceof Error ? error.message : "Unknown error"}` }],
          details: details(meta.description, meta.promptLength, meta.maxTurns, meta.useCitation),
          isError: true,
        };
      }
    },
  });
}
