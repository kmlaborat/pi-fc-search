/**
 * Public entry point for fastcontext agent.
 */

import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { readdirSync, statSync, unlinkSync } from "fs";
import { LLMClient } from "./llm.js";
import { DEFAULT_TEMPERATURE } from "./config.js";
import { ToolSet } from "./tools/types.js";
import { ReadTool } from "./tools/read.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { Agent } from "./agent.js";

export interface RunFastContextAgentOptions {
  prompt: string;
  cwd: string;                 // absolute path, working directory the agent is scoped to
  maxTurns?: number;           // default 15
  citation?: boolean;          // default false — if true, return only the <final_answer> block
  trajectoryFile?: string;     // default: `${os.tmpdir()}/pi-fc-search/trajectory_<timestamp>.jsonl`
  signal?: AbortSignal;
  onTurn?: (n: number, maxTurns: number) => void; // optional per-turn progress hook
  llm: {
    model: string;
    apiKey: string;
    baseUrl: string;
    temperature?: number;      // default 0.2 (SPEC §19 v3: 1.0 was the retired
                               // MS-model default; general small agentic models
                               // call tools more reliably at low temperature)
    topP?: number;             // default 0.95
    maxTokens?: number;        // default 32000
  };
}

// (D-016, SPEC §18) Stale trajectory files are removed from the default
// temp-dir location so repeated runs do not accumulate unbounded debug
// artifacts in the OS temp directory.
const TRAJECTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Best-effort removal of trajectory JSONL files in `dir` older than
 * `maxAgeMs`. All errors are swallowed — cleanup must never affect the
 * search itself. Exported for testing.
 */
export function cleanupOldTrajectories(
  dir: string,
  maxAgeMs: number = TRAJECTORY_MAX_AGE_MS
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Directory does not exist yet — nothing to clean.
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    try {
      const stat = statSync(join(dir, entry));
      if (now - stat.mtimeMs >= maxAgeMs) {
        unlinkSync(join(dir, entry));
      }
    } catch {
      // Entry vanished or is unreadable — skip.
    }
  }
}

/**
 * Execute the FastContext agent with the given options.
 */
export async function runFastContextAgent(options: RunFastContextAgentOptions): Promise<string> {
  const maxTurns = options.maxTurns ?? 15;
  const citation = options.citation ?? false;

  // Construct trajectory file path if not provided.
  // Written to the OS temp dir (never the searched repository) so the
  // extension does not pollute user projects with debug artifacts.
  let trajectoryFile = options.trajectoryFile;
  if (!trajectoryFile) {
    const trajectoryDir = join(tmpdir(), "pi-fc-search");
    // Prune trajectories from older runs (D-016).
    cleanupOldTrajectories(trajectoryDir);
    const timestamp = new Date().toISOString().replace(/[:.-]/g, "_");
    trajectoryFile = join(trajectoryDir, `trajectory_${timestamp}-${randomUUID().slice(0, 8)}.jsonl`);
  }

  // Create LLM client with environment variables
  const llmClient = new LLMClient(options.llm.model, options.llm.apiKey, options.llm.baseUrl, {
    max_tokens: options.llm.maxTokens ?? 32000,
    temperature: options.llm.temperature ?? DEFAULT_TEMPERATURE,
    top_p: options.llm.topP ?? 0.95
  });

  // Create tool set (read-only tools)
  const toolset = new ToolSet([
    new ReadTool(),
    new GlobTool(),
    new GrepTool()
  ], options.cwd);

  // Create and run agent
  const agent = new Agent(
    "FastContext",
    llmClient,
    toolset,
    trajectoryFile,
    options.cwd
  );

  return await agent.run({
    prompt: options.prompt,
    maxTurns,
    citation,
    signal: options.signal, // Pass abort signal for cancellation
    onTurn: options.onTurn
  });
}
