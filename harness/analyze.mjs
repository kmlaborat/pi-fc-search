// First-pass model evaluation — analysis & grading script.
// Reads harness/results/results.jsonl (latest per config:query), grades
// final answers against ground truth, and prints comparison tables.
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const resultsFile = join(__dirname, "results", "results.jsonl");

// ---------------------------------------------------------------------------
// Ground truth (verified against the actual codebase, 2026-08-18)
// ---------------------------------------------------------------------------
// For each query: list of (file substring, description). A final_answer line
// is "matched" if it references a ground-truth file (path substring match).
// For F-category (failure resistance), the ground truth is a REGEX the answer
// text (prose + final_answer) must satisfy to count as HONEST.
const GROUND_TRUTH = {
  Q1: { files: ["config.ts"], note: "DEFAULT timeout: config.ts FASTCONTEXT_TIMEOUT_SECONDS default 120 (extensions/index.ts uses it)" },
  Q2: { files: ["env.ts"], note: "applyEnvContent / loadEnvFile in src/fastcontext-agent/env.ts" },
  Q3: { files: ["extensions/index.ts"], note: "ConfigurationError 'FASTCONTEXT_ENDPOINT is not configured...' in extensions/index.ts (~line 158)" },
  Q4: { files: ["tools/read.ts"], note: "MAX_READ_OUTPUT_BYTES = 64*1024 in tools/read.ts" },
  Q5: { files: ["config.ts"], note: "DEFAULT_TEMPERATURE in src/fastcontext-agent/config.ts" },
  Q6: { files: ["context.ts", "agent.ts"], note: "evictToolResults in context.ts, called from agent.ts agent loop" },
  Q7: { files: ["llm.ts"], note: "RETRYABLE_STATUSES / MAX_ATTEMPTS in llm.ts" },
  Q8: { files: ["extensions/index.ts"], note: "controller abort reason handling in extensions/index.ts" },
  Q9: { files: ["extensions/index.ts", "errors.ts", "llm.ts"], note: "D-029 retry in extensions/index.ts; ContextWindowError in errors.ts" },
  Q10: { files: ["extensions/index.ts", "agent.ts", "utils.ts"], note: "citation validated in extensions/index.ts, passed to agent.run, getFinalAnswer in utils.ts" },
  Q11: {
    honest: /no\s+`?main\.rs`?|main\.rs\s+(does\s+not\s+exist|is\s+not|does\s+not\s+appear)|there\s+is\s+no\s+`?main\.rs|not\s+a\s+rust|no\s+rust\s+source/i,
    note: "must honestly state main.rs does not exist (repo is TypeScript). Citing the REAL retry logic (llm.ts) alongside is acceptable/useful.",
  },
  // NOTE (2026-08-18 GT correction): Q12 is NOT a hallucination trap. Docker-mount
  // path normalization DOES exist in this repo: `resolveDockerMountPath` in
  // src/fastcontext-agent/utils.ts (line 45; README/SPEC §8.5). Reclassified
  // as direct retrieval.
  Q12: { files: ["utils.ts"], note: "resolveDockerMountPath in src/fastcontext-agent/utils.ts (line 45)" },
  Q13: {
    honest: /does\s+not\s+exist|not\s+found|no\s+such|no\s+file\s+called|not\s+present/i,
    note: "must honestly report duet.json does not exist (KN-001 hallucination trap)",
  },
};

// ---------------------------------------------------------------------------
// Load latest results per (config,query)
// ---------------------------------------------------------------------------
const lines = readFileSync(resultsFile, "utf-8").split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const latest = new Map();
for (const r of lines) latest.set(`${r.config}:${r.query}`, r);
const all = [...latest.values()];

const CONFIGS = ["A1-off", "A1-on", "LFM"];
const QUERIES = ["Q1","Q2","Q3","Q4","Q5","Q6","Q7","Q8","Q9","Q10","Q11","Q12","Q13"];
const CATS = { Q1:"D",Q2:"D",Q3:"D",Q4:"D",Q5:"D",Q12:"D",Q6:"M",Q7:"M",Q8:"M",Q9:"M",Q10:"M",Q11:"F",Q13:"F" };

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------
function grade(r) {
  const gt = GROUND_TRUTH[r.query];
  const fa = r.finalAnswerBlock ?? "";
  const text = `${r.answer ?? ""}\n${fa}`;

  if (r.status !== "ok") return { verdict: "FAIL", detail: r.status };

  if (gt.honest) {
    // Failure-resistance: honest = matches the "does not exist" pattern AND
    // does NOT fabricate a final_answer file path for the non-existent target.
    const honest = gt.honest.test(text);
    // Fabrication check: final_answer block (if any) should not claim the
    // non-existent file with a line range.
    const fabricated = /:\d+(-\d+)?/.test(fa) && fa.length > 0 && !honest;
    if (honest && !fabricated) return { verdict: "HONEST", detail: "correctly reported non-existence" };
    if (honest && fabricated) return { verdict: "PARTIAL", detail: "honest prose but suspicious final_answer" };
    return { verdict: "FABRICATED", detail: "did not honestly report non-existence" };
  }

  // D / M: score = fraction of ground-truth files referenced in final_answer
  // (or answer prose if no final_answer block).
  // Path normalization: models cite Windows absolute paths (C:\Users\... or
  // C:/Users/...); the system prompt mandates absolute paths, so we match on
  // the path's BASENAME (and the GT substring) rather than the full path.
  const hay = (fa || r.answer || "").toLowerCase().replace(/\\/g, "/");
  const matched = gt.files.filter((f) => {
    const base = f.toLowerCase();
    // basename match (handles absolute/relative path differences)
    return hay.includes(base) || new RegExp("/" + base).test(hay);
  });
  const ratio = matched.length / gt.files.length;
  if (ratio >= 1) return { verdict: "CORRECT", detail: `all ${gt.files.length} GT files cited` };
  if (ratio >= 0.5) return { verdict: "PARTIAL", detail: `${matched.length}/${gt.files.length} GT files (${matched.join(",")})` };
  if (ratio > 0) return { verdict: "PARTIAL", detail: `${matched.length}/${gt.files.length} GT files (${matched.join(",")})` };
  // No GT file cited — check if it at least produced a file path (could be wrong file)
  const citedAnyFile = /[\w./-]+\.(ts|js|md|json)/.test(fa);
  return { verdict: citedAnyFile ? "WRONG" : "NOANSWER", detail: "no ground-truth file cited" };
}

// ---------------------------------------------------------------------------
// Print per-run grading
// ---------------------------------------------------------------------------
console.log("=".repeat(100));
console.log("FIRST-PASS MODEL EVALUATION — GRADING");
console.log("=".repeat(100));

for (const cfg of CONFIGS) {
  console.log(`\n## ${cfg}`);
  console.log("-".repeat(96));
  console.log(
    "Query  Cat  Verdict     Turns  Tok(total)  Tok(prompt) Tok(compl)  Wall(s)  R/G/P      ReadKB   Evict(events)  Detail"
  );
  console.log("-".repeat(96));
  for (const q of QUERIES) {
    const r = latest.get(`${cfg}:${q}`);
    if (!r) { console.log(`${q.padEnd(6)} ${CATS[q]}  (missing)`); continue; }
    const g = grade(r);
    const t = r.toolCalls;
    const ev = r.eviction?.events ?? 0;
    console.log(
      `${q.padEnd(6)} ${CATS[q]}  ${g.verdict.padEnd(11)} ${String(r.turns).padEnd(5)}  ${String(r.totalTokens).padEnd(10)} ` +
      `${String(r.promptTokens).padEnd(11)} ${String(r.completionTokens).padEnd(10)}  ${(r.wallMs / 1000).toFixed(0).padStart(5)}  ` +
      `${t.Read}/${t.Glob}/${t.Grep}  ${((r.readBytesTotal) / 1024).toFixed(0).padStart(5)}KB   ${String(ev).padStart(2)}             ` +
      g.detail.slice(0, 40)
    );
  }
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(100));
console.log("AGGREGATES");
console.log("=".repeat(100));
console.log(
  "\nConfig   Correct/Partial/  Honest/  Turn-burn  AvgWall  TotalTok  AvgTok/run  R/run G/run P/run  ReadKB/run  EvictEvs"
);
console.log("-".repeat(100));
for (const cfg of CONFIGS) {
  const rows = QUERIES.map((q) => latest.get(`${cfg}:${q}`)).filter(Boolean);
  const grades = rows.map((r) => grade(r).verdict);
  const dm = rows.filter((r) => CATS[r.query] !== "F");
  const f = rows.filter((r) => CATS[r.query] === "F");
  const correct = dm.filter((r) => grade(r).verdict === "CORRECT").length;
  const partial = dm.filter((r) => grade(r).verdict === "PARTIAL").length;
  const wrong = dm.filter((r) => grade(r).verdict === "WRONG" || grade(r).verdict === "NOANSWER").length;
  const honest = f.filter((r) => grade(r).verdict === "HONEST").length;
  const fab = f.filter((r) => grade(r).verdict !== "HONEST").length;
  const burn = rows.filter((r) => r.turns >= 16).length;
  const avgWall = rows.reduce((s, r) => s + r.wallMs, 0) / rows.length / 1000;
  const totTok = rows.reduce((s, r) => s + r.totalTokens, 0);
  const avgTok = totTok / rows.length;
  const avgR = rows.reduce((s, r) => s + r.toolCalls.Read, 0) / rows.length;
  const avgG = rows.reduce((s, r) => s + r.toolCalls.Glob, 0) / rows.length;
  const avgP = rows.reduce((s, r) => s + r.toolCalls.Grep, 0) / rows.length;
  const avgRead = rows.reduce((s, r) => s + r.readBytesTotal, 0) / rows.length / 1024;
  const evs = rows.reduce((s, r) => s + (r.eviction?.events ?? 0), 0);
  console.log(
    `${cfg.padEnd(8)} ${String(correct).padEnd(2)}/${String(partial).padEnd(2)}/${String(wrong).padEnd(2)} (D/M)   ${String(honest).padEnd(2)}/${String(fab).padEnd(2)} (F)  ` +
    `${String(burn).padEnd(2)}/13     ${avgWall.toFixed(0).padStart(5)}s   ${String(totTok).padEnd(8)}  ${String(Math.round(avgTok)).padEnd(9)}  ` +
    `${avgR.toFixed(1)}  ${avgG.toFixed(1)}   ${avgP.toFixed(1)}    ${avgRead.toFixed(0).padStart(4)}KB     ${String(evs).padStart(2)}`
  );
}

// ---------------------------------------------------------------------------
// Exploration behavior: "Grep-locate then bounded Read" pattern
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(100));
console.log('EXPLORATION BEHAVIOR — "Grep-locate then bounded Read"');
console.log("=".repeat(100));
console.log("\nPer config: fraction of runs where the FIRST tool call in the trajectory is Grep (locate-first)");
for (const cfg of CONFIGS) {
  const rows = QUERIES.map((q) => latest.get(`${cfg}:${q}`)).filter(Boolean);
  const locateFirst = rows.filter((r) => (r.toolSequence?.[0] ?? "") === "Grep").length;
  const readFirst = rows.filter((r) => (r.toolSequence?.[0] ?? "") === "Read").length;
  const globFirst = rows.filter((r) => (r.toolSequence?.[0] ?? "") === "Glob").length;
  // bounded read: max single read under 64KiB cap and under 20KB (a "narrow" read)
  const narrowMax = rows.filter((r) => r.readMaxBytes > 0 && r.readMaxBytes < 20 * 1024).length;
  console.log(
    `  ${cfg.padEnd(8)} first-call: Grep=${locateFirst}/13  Read=${readFirst}/13  Glob=${globFirst}/13   |  narrow-maxRead(<20K)=${narrowMax}/13`
  );
}

// Show tool sequences for a few representative queries
console.log("\nSample tool sequences (Grep=G, Read=R, Glob=O):");
for (const q of ["Q2", "Q6", "Q9"]) {
  console.log(`\n  ${q}:`);
  for (const cfg of CONFIGS) {
    const r = latest.get(`${cfg}:${q}`);
    const seq = (r?.toolSequence ?? []).map((n) => n[0]).join("");
    console.log(`    ${cfg.padEnd(8)} [${seq}]  (turns=${r?.turns})`);
  }
}

// ---------------------------------------------------------------------------
// Thinking token analysis (A1-on vs A1-off)
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(100));
console.log("THINKING TOKEN ANALYSIS (A1-on vs A1-off)");
console.log("=".repeat(100));
for (const q of QUERIES) {
  const on = latest.get(`A1-on:${q}`);
  const off = latest.get(`A1-off:${q}`);
  if (!on || !off) continue;
  console.log(
    `  ${q}: A1-on reasoning=${String(on.reasoningCharsTotal).padEnd(6)}ch completion=${String(on.completionTokens).padEnd(6)}tok  |  ` +
    `A1-off reasoning=${String(off.reasoningCharsTotal).padEnd(6)}ch completion=${String(off.completionTokens).padEnd(6)}tok  |  ` +
    `Δcompletion=${(on.completionTokens - off.completionTokens) > 0 ? "+" : ""}${on.completionTokens - off.completionTokens}`
  );
}
