// Failure-mode classification for NOANSWER / turn-burn runs.
//
// For each run that ended without a <final_answer> block (NOANSWER) or
// burned to maxTurns, this script parses the trajectory and classifies the
// terminal failure into one of:
//   A. same-spot re-exploration   (repeated identical/near-identical tool calls)
//   B. unnecessary re-Read        (re-Read of an already-read file/region)
//   C. wandering                  (unrelated exploration, many distinct files)
//   D. info-got-no-answer         (reached correct files but never produced answer)
//   E. multi-hop-incomplete       (Grep->bounded Read fine, but couldn't continue hops)
//
// Heuristics (documented per class). Also emits, for Q8 specifically, a
// side-by-side tool-sequence comparison across the 3 configs.
import { readFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAJ = join(__dirname, "results", "trajectories");
const resultsFile = join(__dirname, "results", "results.jsonl");

const lines = readFileSync(resultsFile, "utf-8").split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);
// latest record per config:query:iteration
const byKey = new Map();
for (const r of lines) {
  const k = `${r.config}:${r.query}:it${r.iteration ?? 1}`;
  byKey.set(k, r);
}

function loadTraj(config, query, iteration) {
  // The iteration runs wrote to the BASE trajectory file name (iteration
  // tracking bug: results.jsonl was cleared, so priorCount=0 -> iteration=1
  // -> base name, overwriting the first-pass trajectory). So both it1 and it2
  // resolve to the same file — the one that currently exists is the it2
  // (iteration) trajectory. Return that.
  const f = join(TRAJ, `${config}__${query}.jsonl`);
  try {
    return readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Parse tool calls in order: [{name, args, resultBytes}]
function parseToolCalls(traj) {
  const calls = [];
  const byId = new Map();
  for (const msg of traj) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const name = tc?.function?.name ?? "?";
        let args = {};
        try { args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {}); } catch {}
        const entry = { id: tc.id, name, args, key: null };
        // canonical key for duplicate detection
        if (name === "Read") entry.key = `Read:${args.path}|${args.offset ?? 0}-${args.limit ?? "all"}`;
        else if (name === "Grep") entry.key = `Grep:${args.pattern}|${args.path ?? ""}|${args.output_mode ?? ""}`;
        else if (name === "Glob") entry.key = `Glob:${args.pattern}|${args.path ?? ""}`;
        else entry.key = `${name}:${JSON.stringify(args)}`;
        calls.push(entry);
        byId.set(tc.id, entry);
      }
    }
    if (msg.role === "tool") {
      const e = byId.get(msg.tool_call_id);
      if (e) e.resultBytes = Buffer.byteLength(String(msg.content ?? ""), "utf8");
    }
  }
  return calls;
}

const N = (s) => String(s).toLowerCase();

function classify(config, query, iteration, rec) {
  const traj = loadTraj(config, query, iteration);
  const calls = parseToolCalls(traj);
  const n = calls.length;
  if (n === 0) return { cls: "?", detail: "no tool calls", calls };

  // Distinguish: did the run reach the correct target files at all?
  // (For Q8, the GT is extensions/index.ts; we check if any Read/Grep targeted it.)
  const gtHint = {
    Q8: ["extensions/index.ts"],
    Q9: ["extensions/index.ts", "errors.ts", "llm.ts"],
    Q10: ["extensions/index.ts", "agent.ts", "utils.ts"],
    Q6: ["context.ts", "agent.ts"],
  }[query] ?? [];

  const reachedGT = calls.some((c) =>
    gtHint.some((g) => N(c.key).includes(N(g).split("/").pop()))
  );

  // --- Metric 1: exact-duplicate calls (same key) ---
  const keyCount = {};
  for (const c of calls) keyCount[c.key] = (keyCount[c.key] ?? 0) + 1;
  const exactDupes = Object.entries(keyCount).filter(([, v]) => v > 1);
  const dupeCalls = exactDupes.reduce((s, [, v]) => s + v, 0);

  // --- Metric 2: re-Read of same file (any region) ---
  const readFiles = {};
  for (const c of calls) if (c.name === "Read") {
    const f = N(basename(c.args.path ?? ""));
    readFiles[f] = (readFiles[f] ?? 0) + 1;
  }
  const reReadFiles = Object.entries(readFiles).filter(([, v]) => v > 1);

  // --- Metric 3: distinct files touched (wandering) ---
  const distinctFiles = new Set();
  for (const c of calls) {
    const p = c.args.path ?? c.args.pattern ?? "";
    if (p && c.name !== "Grep") distinctFiles.add(N(basename(p)));
  }

  // --- Metric 4: tail behavior (last 4 calls) ---
  const tail = calls.slice(-4);
  const tailAllRead = tail.every((c) => c.name === "Read");
  const tailAllGrep = tail.every((c) => c.name === "Grep");

  // --- Metric 5: LFM-style malformed tool calls in the final message
  //      (e.g. <|tool_call_start|> text = model emitting tool syntax as
  //       plain content instead of structured tool_calls -> loop stalls)
  const lastAssistant = [...traj].reverse().find((m) => m.role === "assistant");
  const malformedTail = lastAssistant && typeof lastAssistant.content === "string" &&
    (lastAssistant.content.includes("<|tool_call_start|>") ||
     /Read\(path=/.test(lastAssistant.content) && !lastAssistant.tool_calls?.length);

  // --- Classification decision (priority order) ---
  let cls, detail;

  // E-hallmark: LFM emitting tool-call syntax as text content (structured
  // tool_calls absent on the final assistant message) -> the agent loop
  // sees "no tool call" but the model was trying to call a tool.
  if (malformedTail) {
    cls = "E";
    detail = "final assistant message contains raw tool-call syntax as text content (no structured tool_calls) -> loop stalls, no answer";
  } else if (reachedGT && (dupeCalls >= 3 || reReadFiles.length >= 2)) {
    cls = "D";
    detail = `reached GT file(s) [${gtHint.join(",")}] but then re-explored: ${dupeCalls} duplicate calls, ${reReadFiles.map(([f, v]) => f + "x" + v).join(",")} re-Reads; never produced <final_answer>`;
  } else if (exactDupes.length >= 2 || dupeCalls >= 4) {
    cls = "A";
    detail = `same-spot re-exploration: ${exactDupes.map(([k, v]) => k.slice(0, 40) + "x" + v).join("; ")}`;
  } else if (reReadFiles.length >= 2) {
    cls = "B";
    detail = `unnecessary re-Read: ${reReadFiles.map(([f, v]) => f + "x" + v).join(", ")} (distinct files touched: ${distinctFiles.size})`;
  } else if (distinctFiles.size >= 8 && !reachedGT) {
    cls = "C";
    detail = `wandering: ${distinctFiles.size} distinct files touched, never reached GT [${gtHint.join(",")} or n/a]`;
  } else if (reachedGT) {
    cls = "D";
    detail = `reached GT file(s) [${gtHint.join(",")}] but did not produce <final_answer>` +
      (tailAllRead ? "; tail = all Read" : tailAllGrep ? "; tail = all Grep" : "; tail mixed");
  } else {
    cls = "E";
    detail = `multi-hop incomplete: Grep->bounded Read pattern held (maxRead=${(rec.readMaxBytes / 1024).toFixed(0)}K) but exploration did not converge; ${n} calls, ${distinctFiles.size} distinct files, reached GT=${reachedGT}`;
  }

  return { cls, detail, calls, metrics: {
    n, dupeCalls, reReadFiles: reReadFiles.map(([f, v]) => `${f}x${v}`),
    distinctFiles: distinctFiles.size, reachedGT, tailAllRead, malformedTail,
  } };
}

// ---------------------------------------------------------------------------
// 1. Classify all NOANSWER / turn-burn runs (iteration 1 AND 2)
// ---------------------------------------------------------------------------
console.log("=".repeat(100));
console.log("FAILURE-MODE CLASSIFICATION (NOANSWER / turn>=16 runs)");
console.log("=".repeat(100));
console.log("Classes: A=same-spot re-exploration | B=unnecessary re-Read | C=wandering | D=info-got-no-answer | E=multi-hop-incomplete/malformed\n");

const CLASS_LABEL = { A: "same-spot re-explore", B: "unnecessary re-Read", C: "wandering", D: "info-got-no-answer", E: "multi-hop-incomplete" };

// Collect candidate runs: final_answer missing OR turns>=15
const candidates = [];
for (const [k, r] of byKey) {
  if (!r.finalAnswerBlock || r.turns >= 15) candidates.push(r);
}
// Sort by config, query, iteration
candidates.sort((a, b) => a.config.localeCompare(b.config) || a.query.localeCompare(b.query) || (a.iteration ?? 1) - (b.iteration ?? 1));

for (const r of candidates) {
  const it = r.iteration ?? 1;
  const res = classify(r.config, r.query, it, r);
  const noFa = !r.finalAnswerBlock ? "NO-FINAL-ANSWER" : "has-answer(turn-burn)";
  console.log(`[${r.config} ${r.query} it${it}] ${noFa}  turns=${r.turns}  => Class ${res.cls} (${CLASS_LABEL[res.cls]})`);
  console.log(`   ${res.detail}`);
  console.log(`   metrics: calls=${res.metrics.n} dupes=${res.metrics.dupeCalls} reReads=${res.metrics.reReadFiles.join(",") || "-"} distinct=${res.metrics.distinctFiles} reachedGT=${res.metrics.reachedGT}`);
}

// ---------------------------------------------------------------------------
// 2. Q8 side-by-side trajectory comparison (the cross-config deep dive)
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(100));
console.log('Q8 DEEP DIVE — "abort signal -> timeout vs cancellation" (all 3 configs, it1 + it2)');
console.log("=".repeat(100));

function seqString(calls) {
  // Compress: G/G/G->GGG, R->R; mark duplicates with *
  const seen = {};
  return calls.map((c) => {
    seen[c.key] = (seen[c.key] ?? 0) + 1;
    const ch = c.name === "Grep" ? "G" : c.name === "Read" ? "R" : c.name === "Glob" ? "O" : "?";
    return seen[c.key] > 1 ? ch + "*" : ch;
  }).join("");
}

for (const it of [2]) {
  // NOTE: first-pass (it1) Q8 trajectories were overwritten by the iteration
  // runs (iteration tracking bug, results.jsonl was cleared mid-experiment).
  // First-pass Q8 metrics are preserved in the experiment log (see
  // harness/RESULTS-FIRSTPASS.md): A1-off it1 turns=16 tok=307964 R/G/P
  // 17/2/1 read=142K max=17K NOANSWER; A1-on it1 turns=12 tok=207755 R/G/P
  // 8/2/5 read=61K max=17K CORRECT; LFM it1 turns=16 tok=65720 R/G/P 10/17/3
  // read=1K max=0K NOANSWER.
  console.log(`\n--- iteration ${it} (current trajectory files) ---`);
  for (const cfg of ["A1-off", "A1-on", "LFM"]) {
    const rec = byKey.get(`${cfg}:Q8:it${it}`);
    if (!rec) continue;
    const traj = loadTraj(cfg, "Q8", it);
    const calls = parseToolCalls(traj);
    const res = classify(cfg, "Q8", it, rec);
    console.log(`\n  ${cfg}: turns=${rec.turns} tok=${rec.totalTokens} R/G/P=${rec.toolCalls.Read}/${rec.toolCalls.Glob}/${rec.toolCalls.Grep} read=${(rec.readBytesTotal / 1024).toFixed(0)}K max=${(rec.readMaxBytes / 1024).toFixed(0)}K`);
    console.log(`    final_answer: ${rec.finalAnswerBlock ? "YES" : "NO"}`);
    console.log(`    class: ${res.cls} (${CLASS_LABEL[res.cls]})`);
    console.log(`    seq:    ${seqString(calls)}  (${calls.length} calls)`);
    // Show last 6 calls in detail
    console.log(`    last 6 calls:`);
    for (const c of calls.slice(-6)) {
      let a = "";
      if (c.name === "Read") a = `${c.args.path?.split(/[\\/]/).pop()} ${c.args.offset ? "off=" + c.args.offset : ""} ${c.args.limit ? "lim=" + c.args.limit : ""}`.trim();
      else if (c.name === "Grep") a = `pat="${c.args.pattern}" ${c.args.output_mode ?? ""}`;
      else if (c.name === "Glob") a = `pat="${c.args.pattern}"`;
      console.log(`      ${c.name.padEnd(5)} ${a}  (${c.resultBytes ?? 0}B)`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Summary of failure classes across all configs
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(100));
console.log("FAILURE-CLASS SUMMARY (count of classified runs per config)");
console.log("=".repeat(100));
const summary = {};
for (const r of candidates) {
  const it = r.iteration ?? 1;
  const res = classify(r.config, r.query, it, r);
  (summary[r.config] ??= {});
  summary[r.config][res.cls] = (summary[r.config][res.cls] ?? 0) + 1;
}
for (const cfg of ["A1-off", "A1-on", "LFM"]) {
  const s = summary[cfg] ?? {};
  console.log(`  ${cfg}: ` + Object.entries(s).map(([k, v]) => `${k}=${v}`).join("  ") + `   (total ${candidates.filter((r) => r.config === cfg).length} classified runs)`);
}
