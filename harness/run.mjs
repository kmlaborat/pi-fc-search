// pi-fc-search model evaluation harness (first-pass experiment)
//
// Runs the in-process fastcontext agent (src/fastcontext-agent) against a
// fixed set of queries with different LLM model configurations, and records
// per-run metrics for comparison.
//
// Usage:
//   node harness/run.mjs                 // run all pending runs
//   node harness/run.mjs --dry-run       // list the run matrix without calling the LLM
//   node harness/run.mjs --only A1-off:Q1 // run a single (config,query) pair
//   node harness/run.mjs --list          // show current results summary
//
// Results: harness/results.jsonl  (one JSON object per run, appended)
// Trajectories: harness/trajectories/<config>__<query>.jsonl (one per run)
//
// Design notes:
// - Uses the REAL agent code (Agent + LLMClient + ToolSet + Context, same
//   wiring as runFastContextAgent) so behavior matches the installed
//   extension exactly.
// - Token usage: the response `usage` sibling is dropped by the agent's
//   extractRawMessage, so we intercept at the fetch level to capture usage,
//   finish_reason, and reasoning/content lengths per LLM call.
// - Tool calls are captured by wrapping toolset.callNormalized (name+args
//   and output byte size per call).

import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OUT_DIR = join(__dirname, "results");
const TRAJ_DIR = join(OUT_DIR, "trajectories");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const LLM = {
  // Read from the environment at run time so the harness stays commit-safe
  // (no internal hostnames/credentials hardcoded — see
  // harness/RESULTS-FIRSTPASS.md for the benchmark endpoint actually used).
  baseUrl: process.env.FASTCONTEXT_ENDPOINT ?? "http://127.0.0.1:8080/v1",
  apiKey: process.env.FASTCONTEXT_API_KEY ?? "",
  temperature: 0.2,
  topP: 0.95,
  maxTokens: 32000,
};

const TIMEOUT_SECONDS = 600; // experiment budget; wall time recorded separately

// Model configurations (llama-swap state at 2026-08-18 experiment time):
// - `Agents-A1-4B` == `Agents-A1-4B-np4` == same GGUF (Agents-A1-4B-Q8_0.gguf),
//   Q8 verified via the `model` field in responses.
// - llama-swap tags (`:instruct-reasoning` / `:thinking-coding`) are NOT
//   currently routed for Agents-A1-4B (404), so thinking-off is achieved via
//   `chat_template_kwargs.enable_thinking: false` (Qwen3.5-based mechanism,
//   SPEC KN-005 sampling note) — verified stable over repeated calls and with
//   tool calling.
const CONFIGS = [
  {
    id: "A1-off",
    model: "Agents-A1-4B",
    thinking: "off (chat_template_kwargs.enable_thinking=false)",
    bodyExtras: { chat_template_kwargs: { enable_thinking: false } },
  },
  { id: "A1-on", model: "Agents-A1-4B", thinking: "on (default)", bodyExtras: {} },
  { id: "LFM", model: "LFM2.5-2.6B", thinking: "always-on (no off switch)", bodyExtras: {} },
];

// Query categories:
//   D = direct retrieval (locate a known specific thing)
//   M = multi-hop exploration (reason across several files)
//   F = failure resistance (hallucination / non-existent target / stagnation)
const QUERIES = [
  {
    id: "Q1",
    cat: "D",
    prompt: "Find where the default LLM call timeout (execution timeout in seconds) is defined as a constant or default value.",
  },
  {
    id: "Q2",
    cat: "D",
    prompt: "Find the function that parses .env file content and applies FASTCONTEXT_* keys. Which file and function?",
  },
  {
    id: "Q3",
    cat: "D",
    prompt: "Find the exact error message string returned when the LLM endpoint is not configured (missing FASTCONTEXT_ENDPOINT).",
  },
  {
    id: "Q4",
    cat: "D",
    prompt: "Find where the 64 KiB cap on a single Read tool output is enforced.",
  },
  {
    id: "Q5",
    cat: "D",
    prompt: "Find where the default temperature value for LLM calls is defined.",
  },
  {
    id: "Q6",
    cat: "M",
    prompt: "Explain how the eviction of tool results (the 64 KiB combined tool-result budget) is wired into the agent loop: where is it defined, where is it called from, and what does the stub replacement contain?",
  },
  {
    id: "Q7",
    cat: "M",
    prompt: "Trace the retry policy for transient LLM API failures: which statuses are retried, how many attempts, what backoff is used, and in which file is this implemented?",
  },
  {
    id: "Q8",
    cat: "M",
    prompt: "How does the extension convert an aborted controller signal into the correct tool result (timeout vs user cancellation)? Trace from the timeout/cancellation setup to the final error returned to the caller.",
  },
  {
    id: "Q9",
    cat: "M",
    prompt: "Find all places that reference or implement the D-029 context-window auto-retry (retry once with halved turn budget). List the files involved in the flow from detection to retry.",
  },
  {
    id: "Q10",
    cat: "M",
    prompt: "How does the citation mode (use_citation) differ from default mode in the code? Trace where the flag is validated, passed through, and where the final answer extraction branches on it.",
  },
  {
    id: "Q11",
    cat: "F",
    prompt: "What is the content of the retry logic in main.rs? (If the file does not exist in this repository, say so and identify what the repository actually is.)",
  },
  {
    id: "Q12",
    cat: "F",
    prompt: "Find the implementation of the FastContext Docker-mount path normalization. (If no such thing exists in this codebase, report that honestly and describe the closest related path-handling logic.)",
  },
  {
    id: "Q13",
    cat: "F",
    prompt: "Find the duet.json configuration file and its schema definition.",
  },
];

const MAX_TURNS = 15;

// ---------------------------------------------------------------------------
// Agent wiring (mirrors runFastContextAgent, with usage capture)
// ---------------------------------------------------------------------------

/**
 * Import the TypeScript agent modules through jiti (same loader pi uses).
 */
async function loadAgentModules() {
  const jitiDir = "C:/Users/Game/MyDevEnv/node/.npm-global/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti";
  const pj = JSON.parse(readFileSync(join(jitiDir, "package.json"), "utf-8"));
  const base = pathToFileURL(jitiDir.replace(/\\/g, "/") + "/");
  const { createJiti } = await import(new URL(pj.main, base).href);
  const jiti = createJiti(import.meta.url);

  const [agentMod, llmMod, ctxMod, typesMod, readTool, globTool, grepTool] =
    await Promise.all([
      jiti.import(REPO_ROOT + "/src/fastcontext-agent/agent.ts"),
      jiti.import(REPO_ROOT + "/src/fastcontext-agent/llm.ts"),
      jiti.import(REPO_ROOT + "/src/fastcontext-agent/context.ts"),
      jiti.import(REPO_ROOT + "/src/fastcontext-agent/tools/types.ts"),
      jiti.import(REPO_ROOT + "/src/fastcontext-agent/tools/read.ts"),
      jiti.import(REPO_ROOT + "/src/fastcontext-agent/tools/glob.ts"),
      jiti.import(REPO_ROOT + "/src/fastcontext-agent/tools/grep.ts"),
    ]);

  return {
    Agent: agentMod.Agent,
    LLMClient: llmMod.LLMClient,
    Context: ctxMod.Context,
    ContextEvict: ctxMod.evictToolResults,
    ToolSet: typesMod.ToolSet,
    ReadTool: readTool.ReadTool,
    GlobTool: globTool.GlobTool,
    GrepTool: grepTool.GrepTool,
  };
}

/**
 * Run one (config, query) pair. Returns a result record.
 */
async function runOne(mods, config, query, cwd, iteration) {
  // Trajectory file name includes the iteration so re-runs do not overwrite
  // the first-pass trajectory (iteration 1 keeps the original naming for
  // continuity with the existing 39 first-pass files).
  const suffix = iteration > 1 ? `__it${iteration}` : "";
  const trajectoryFile = join(TRAJ_DIR, `${config.id}__${query.id}${suffix}.jsonl`);
  if (existsSync(trajectoryFile)) {
    // Overwrite semantics: harness starts fresh each invocation of a run.
    const { unlinkSync } = await import("fs");
    try { unlinkSync(trajectoryFile); } catch {}
  }

  const llm = new mods.LLMClient(config.model, LLM.apiKey, LLM.baseUrl, {
    max_tokens: LLM.maxTokens,
    temperature: LLM.temperature,
    top_p: LLM.topP,
  });

  // ---- usage + per-call latency capture ----
  // Interception at the fetch level (agent code unmodified): capture `usage`
  // and reasoning/content lengths from each /chat/completions response.
  const usageLog = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    // Inject per-config extra body params (e.g. chat_template_kwargs) into
    // the outgoing /chat/completions payload.
    try {
      const u = String(url);
      if (u.includes("/chat/completions") && opts && typeof opts.body === "string" && config.bodyExtras && Object.keys(config.bodyExtras).length) {
        const body = JSON.parse(opts.body);
        Object.assign(body, config.bodyExtras);
        opts = { ...opts, body: JSON.stringify(body) };
      }
    } catch {}
    const t0 = Date.now();
    const res = await realFetch(url, opts);
    const dt = Date.now() - t0;
    try {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        const clone = res.clone();
        clone.json().then((data) => {
          usageLog.push({
            ok: res.ok,
            status: res.status,
            dt,
            usage: data.usage ?? null,
            finishReason: data.choices?.[0]?.finish_reason ?? null,
            reasoningLen: (data.choices?.[0]?.message?.reasoning_content ?? "").length,
            contentLen: (data.choices?.[0]?.message?.content ?? "").length,
          });
        }).catch(() => {});
      }
    } catch {}
    return res;
  };

  const toolset = new mods.ToolSet(
    [new mods.ReadTool(), new mods.GlobTool(), new mods.GrepTool()],
    cwd
  );

  // ---- tool call capture (single wrapper: name+args AND output bytes) ----
  const toolLog = [];
  const originalCall = toolset.callNormalized.bind(toolset);
  toolset.callNormalized = async (calls) => {
    for (const c of calls) {
      toolLog.push({ id: c.id, name: c.name, args: c.arguments, bytes: 0, failed: false });
    }
    const results = await originalCall(calls);
    for (const r of results) {
      const e = toolLog.find((t) => t.id === r.toolCallId);
      if (e) {
        e.bytes = Buffer.byteLength(String(r.output ?? ""), "utf8");
        e.failed = r.failed;
      }
    }
    return results;
  };

  const agent = new mods.Agent("FastContext", llm, toolset, trajectoryFile, cwd);

  const record = {
    ts: new Date().toISOString(),
    iteration: 1,
    config: config.id,
    model: config.model,
    thinking: config.thinking,
    query: query.id,
    category: query.cat,
    prompt: query.prompt,
    maxTurns: MAX_TURNS,
    timeoutSeconds: TIMEOUT_SECONDS,
    status: "ok",        // ok | error | timeout
    error: null,
    answer: null,
    turns: 0,
    wallMs: 0,
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningCharsTotal: 0,
    contentCharsTotal: 0,
    llmMsTotal: 0,
    toolCalls: { Read: 0, Glob: 0, Grep: 0, other: 0 },
    toolFailed: 0,
    readBytesTotal: 0,
    readMaxBytes: 0,
    grepCalls: 0,
    eviction: { evictedCount: 0, bytesBefore: 0, bytesAfter: 0, maxBytesBefore: 0 },
    finalAnswerBlock: null,
    trajectoryFile: trajectoryFile,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_SECONDS * 1000);

  const t0 = Date.now();
  try {
    const answer = await agent.run({
      prompt: query.prompt,
      maxTurns: MAX_TURNS,
      citation: false,
      signal: controller.signal,
      onTurn: (n) => { record.turns = n; },
    });
    record.answer = answer;
  } catch (err) {
    record.status = controller.signal.aborted ? "timeout" : "error";
    record.error = `${err?.constructor?.name ?? "Error"}: ${err?.message ?? err}`;
  } finally {
    clearTimeout(timer);
    record.wallMs = Date.now() - t0;
    globalThis.fetch = realFetch;
  }

  // ---- aggregate usage ----
  for (const u of usageLog) {
    if (u.usage) {
      record.llmCalls++;
      record.promptTokens += u.usage.prompt_tokens ?? 0;
      record.completionTokens += u.usage.completion_tokens ?? 0;
      record.totalTokens += u.usage.total_tokens ?? 0;
      record.cachedPromptTokens += u.usage.prompt_tokens_details?.cached_tokens ?? 0;
      record.reasoningCharsTotal += u.reasoningLen ?? 0;
      record.contentCharsTotal += u.contentLen ?? 0;
    }
    if (u.dt) record.llmMsTotal += u.dt;
  }

  // ---- aggregate tools ----
  for (const e of toolLog) {
    if (!e.name) continue;
    const key = e.name === "Read" || e.name === "Glob" || e.name === "Grep" ? e.name : "other";
    record.toolCalls[key] = (record.toolCalls[key] ?? 0) + 1;
    if (e.failed) record.toolFailed++;
    if (e.name === "Read") {
      record.readBytesTotal += e.bytes;
      record.readMaxBytes = Math.max(record.readMaxBytes, e.bytes);
    }
  }
  record.grepCalls = record.toolCalls.Grep;

  // ---- eviction: measure with the pure function (no mutation) ----
  // `eviction.evictedCount` here = how many tool results WOULD be stubbed if
  // the budget check ran at the end of the run (i.e. whether the run ended
  // with history over the 64 KiB tool-result budget). Combined with
  // readBytesTotal this shows context pressure per run.
  try {
    if (typeof mods.ContextEvict === "function") {
      const { report } = mods.ContextEvict(agent.context.history, 64 * 1024);
      record.eviction.evictedCount = report.evictedCount;
      record.eviction.bytesBefore = report.bytesBefore;
      record.eviction.bytesAfter = report.bytesAfter;
    }
  } catch {}

  // ---- final answer block ----
  if (record.answer) {
    const m = record.answer.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
    if (m) record.finalAnswerBlock = m[1].trim();
  }

  // ---- trajectory-derived exploration metrics ----
  // (a) per-call tool sequence from assistant tool_calls entries,
  // (b) eviction event count: how many times the 64 KiB budget actually
  //     fired during the run (stub content observed in history). The
  //     end-of-run `record.eviction` above measures the FINAL history state;
  //     this counts the dynamic events across all turns.
  try {
    const trajLines = readFileSync(trajectoryFile, "utf-8").split("\n").filter(Boolean);
    const seq = [];
    let evictEvents = 0;
    let evictMaxBytesBefore = 0;
    for (const line of trajLines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc?.function?.name ?? "?";
          seq.push(name);
        }
      }
      if (msg.role === "tool" && typeof msg.content === "string" &&
          msg.content.startsWith("[Tool result evicted")) {
        evictEvents++;
        const mb = msg.content.match(/original size (\d+) bytes/);
        if (mb) evictMaxBytesBefore = Math.max(evictMaxBytesBefore, parseInt(mb[1], 10));
      }
    }
    record.toolSequence = seq;
    record.eviction.events = evictEvents;
    record.eviction.maxOriginalBytes = evictMaxBytesBefore;
  } catch {}

  return record;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const RESULTS_FILE = join(OUT_DIR, "results.jsonl");

function loadExistingResults() {
  if (!existsSync(RESULTS_FILE)) return [];
  return readFileSync(RESULTS_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function printSummary(results) {
  if (!results.length) { console.log("(no results yet)"); return; }
  const byConfig = {};
  for (const r of results) {
    (byConfig[r.config] ??= []).push(r);
  }
  for (const [cfg, rows] of Object.entries(byConfig)) {
    const ok = rows.filter((r) => r.status === "ok").length;
    const tot = rows.length;
    const tok = rows.reduce((s, r) => s + (r.totalTokens || 0), 0);
    const wall = rows.reduce((s, r) => s + (r.wallMs || 0), 0) / 1000;
    const turns = rows.reduce((s, r) => s + (r.turns || 0), 0) / tot;
    console.log(
      `\n[${cfg}] ${ok}/${tot} ok | avg turns ${turns.toFixed(1)} | total tokens ${tok} | total wall ${(wall / 60).toFixed(1)} min`
    );
    for (const r of rows) {
      const t = r.toolCalls;
      console.log(
        `  ${r.query} (${r.category}) ${r.status.padEnd(7)} turns=${String(r.turns).padEnd(2)} ` +
        `tok=${String(r.totalTokens || 0).padEnd(6)} wall=${(r.wallMs / 1000).toFixed(0).padStart(4)}s ` +
        `R=${t.Read ?? 0} G=${t.Glob ?? 0} P=${t.Grep ?? 0} ` +
        `readBytes=${(r.readBytesTotal / 1024).toFixed(0)}K max=${(r.readMaxBytes / 1024).toFixed(0)}K ` +
        `evict=${r.eviction.evictedCount} ${r.error ? "| " + r.error.slice(0, 80) : ""}`
      );
    }
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const listOnly = args.includes("--list");
let only = null;
const onlyIdx = args.findIndex((a) => a.startsWith("--only"));
if (onlyIdx >= 0) {
  // Support both `--only A1-off:Q1` and `--only=A1-off:Q1`.
  const flag = args[onlyIdx];
  if (flag.includes("=")) {
    only = flag.split("=").slice(1).join("=");
  } else {
    only = args[onlyIdx + 1];
  }
}

if (listOnly) {
  const all = loadExistingResults();
  const latest = new Map();
  for (const r of all) latest.set(`${r.config}:${r.query}`, r);
  printSummary([...latest.values()]);
  process.exit(0);
}

mkdirSync(TRAJ_DIR, { recursive: true });

const mods = await loadAgentModules();

const cwd = process.cwd();

// Build run matrix
const matrix = [];
for (const c of CONFIGS) for (const q of QUERIES) matrix.push({ c, q });

if (dryRun) {
  for (const { c, q } of matrix) console.log(`${c.id} ${q.id} (${q.cat}) ${q.prompt.slice(0, 60)}`);
  console.log(`\nTotal runs: ${matrix.length}`);
  process.exit(0);
}

// Determine which runs to perform: all, or --only
let selected = matrix;
if (only) {
  const [cid, qid] = only.split(":");
  selected = matrix.filter(({ c, q }) => c.id === cid && q.id === qid);
  if (!selected.length) { console.error(`No run matches --only ${only}`); process.exit(1); }
}

// Iteration support: a second invocation for the same (config,query) appends
// a NEW record with `iteration` = (prior record count for that pair)+1.
// First-pass records stay at iteration=1. Results are keyed by
// config:query:iteration in analysis.
//
// Skip already-completed (config,query) pairs unless --rerun.
// "Completed" = the LATEST record for that pair has a non-error status;
// failed runs are automatically re-selected on the next invocation.
const rerun = args.includes("--rerun");
let existing = loadExistingResults();
if (rerun) existing = [];
const latestByKey = new Map();
for (const r of existing) latestByKey.set(`${r.config}:${r.query}`, r);
const done = new Set(
  [...latestByKey.entries()]
    .filter(([, r]) => r.status !== "error" && r.status !== "timeout")
    .map(([k]) => k)
);

const todo = selected.filter(({ c, q }) => !done.has(`${c.id}:${q.id}`));
console.log(`Selected ${selected.length}, already done ${selected.length - todo.length}, to run: ${todo.length}`);

for (let i = 0; i < todo.length; i++) {
  const { c, q } = todo[i];
  process.stdout.write(`\n=== [${i + 1}/${todo.length}] ${c.id} x ${q.id} (${q.cat}) model=${c.model} ===\n`);
  console.log(`prompt: ${q.prompt.slice(0, 100)}`);
  // Iteration number = prior records for this (config,query) + 1 (must be
  // computed BEFORE runOne so the trajectory file name is correct).
  const priorCount = loadExistingResults().filter(
    (r) => r.config === c.id && r.query === q.id
  ).length;
  const iteration = priorCount + 1;
  const rec = await runOne(mods, c, q, cwd, iteration);
  rec.iteration = iteration;
  appendFileSync(RESULTS_FILE, JSON.stringify(rec) + "\n");
  const t = rec.toolCalls;
  console.log(
    `=> ${rec.status} turns=${rec.turns} tokens=${rec.totalTokens} wall=${(rec.wallMs / 1000).toFixed(0)}s ` +
    `R=${t.Read} G=${t.Glob} P=${t.Grep} read=${(rec.readBytesTotal / 1024).toFixed(0)}K evict=${rec.eviction.evictedCount}` +
    (rec.error ? ` | ${rec.error.slice(0, 120)}` : "")
  );
  if (rec.finalAnswerBlock) console.log(`final_answer:\n${rec.finalAnswerBlock}`);
}

console.log("\n--- SUMMARY (this run batch + previous) ---");
// Latest record per (config,query) wins — earlier failed attempts are
// superseded by their successful re-runs.
const all = loadExistingResults();
const latest = new Map();
for (const r of all) latest.set(`${r.config}:${r.query}`, r);
printSummary([...latest.values()]);
