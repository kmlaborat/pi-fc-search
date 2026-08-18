# VFPT (repository navigation layer) A/B experiment — design

## Purpose

Validate the hypothesis that a **repository navigation layer** (a
Virtual File Partition Tree — "VFPT", in its *navigation-only* form) reduces
exploration-space wandering for small models, using **LFM2.5-2.6B Q8** as the
test subject (the model whose measured failure mode is wandering: duplicate
Glob/Grep, reads of non-existent paths, malformed tool calls — see
`harness/RESULTS-FIRSTPASS.md`).

## What VFPT means in this experiment (scope discipline)

Two effects are deliberately kept separate:

1. **Stage 1 (this experiment): repository navigation layer ONLY.**
   The model is given an *up-front structured map of the repository*
   (directories + files with sizes, one level of nesting or a flat
   path:line-count table) so it does not have to discover the file space by
   `Glob *` / guessing paths. **File content partitioning is NOT changed**:
   `Read` behaves exactly as today (64 KiB cap, offset/limit). No new
   virtual-file mechanics.
2. **Stage 2 (later, only if stage 1 shows a signal): virtual file
   partitioning** — hierarchical `Read` of large files. Explicitly OUT of
   scope here; LFM already does bounded `Read` correctly.

### Stage-1 VFPT delivery mechanism (candidate, to finalize)

Minimal, non-invasive, consistent with the existing prompt design
(SPEC §19 C-3 already substitutes `${WORK_DIR}` and a top-level `${WORK_DIR_LS}`):

- **Option A (preferred): extend the system prompt's Workspace section.**
  Replace/augment the single-level `Top-level entries` block with a compact
  tree (e.g. up to depth 2, files with size in KiB, directories with entry
  count), capped at a fixed budget (e.g. 4 KiB of prompt text). This is a
  prompt-only change — zero tool changes, zero behavior changes elsewhere.
- **Option B (fallback): a new read-only `Tree` tool** returning the same
  map on demand. More flexible but adds a tool-call cost per use and changes
  the tool schema; only if Option A's static prompt proves too coarse.

We start with **Option A**. The baseline keeps the current top-level-only
`WORK_DIR_LS`.

## Hypothesis (falsifiable)

Given the same LFM2.5-2.6B Q8 model, queries, and budget:

- `treatment` (VFPT nav layer) will show **fewer duplicate tool calls**,
  **fewer non-existent-path accesses**, **fewer duplicate `Glob`**, and a
  **lower maxTurns-reached rate** than `baseline` (current fc_search),
  **without regressing accuracy or total tokens**.

If VFPT does not reduce wandering metrics, the hypothesis is not supported
and VFPT (stage 1) is not adopted.

## Arms

| Arm | fc_search config | Description |
|-----|------------------|-------------|
| **baseline** | current (top-level `WORK_DIR_LS` only) | Exactly today's behavior. |
| **treatment** | current + VFPT navigation layer (Option A) | System prompt carries the repo map; tools/Read unchanged. |

Everything else identical: same model, same endpoint, same `max_turns=15`,
`temperature=0.2`, `top_p=0.95`, 600 s budget, same cwd, same query set.

## Subject & queries

- **Model:** `LFM2.5-2.6B` (Q8) only. (Agents-A1-4B is not the target of the
  wandering hypothesis; it may be added later as a secondary subject.)
- **Queries:** the multi-hop / wandering-prone set from the first pass:
  **Q6, Q8, Q10, Q12** (primary) plus **Q13** (failure-resistance, also
  wandering-prone) as a secondary check. 5 queries × 2 arms.
- **Repetitions:** each (arm, query) run **3×** to get a distribution (small
  models are stochastic). Total = 5 × 2 × 3 = **30 runs**.

## Metrics (per run, all already captured or trivially added by the harness)

| # | Metric | Source |
|---|--------|--------|
| 1 | Accuracy (correct / partial / wrong, vs ground truth) | `analyze.mjs` grading |
| 2 | Turn count (and whether it reached maxTurns) | agent `onTurn` |
| 3 | Tool-call count (total; and Read/Glob/Grep split) | `toolset.callNormalized` wrapper |
| 4 | **Duplicate exploration count** (identical tool key repeated) | `failure-classify.mjs` `keyCount` |
| 5 | **Non-existent-path accesses** (Read/Glob/Grep on a path that does not exist) | NEW: check each path arg against `fs.existsSync` at call time |
| 6 | **Duplicate `Glob` count** (same pattern+path repeated) | subset of #4, Glob-only |
| 7 | Max `Read` size (bytes) | existing `readMaxBytes` |
| 8 | Total tokens (prompt+completion) | fetch-level `usage` capture |
| 9 | Wall time (ms) | existing `wallMs` |
| 10 | maxTurns-reached rate (turns ≥ 16, i.e. forced final turn hit) | `turns` |

Metrics #5 (non-existent-path) is the one new capture; it directly measures
the KN-001-style hallucinated-path wandering that VFPT is hypothesized to
fix.

## Randomization & confound control

- **Order:** interleave arms per query (baseline, treatment, baseline,
  treatment, …) and randomize the 3 repetitions' order, so server load /
  model warm-state does not bias one arm.
- **Server state:** both arms hit the same llama-swap endpoint; record the
  run timestamp. If `LFM2.5-2.6B` gets unloaded mid-experiment, re-load is
  symmetric across arms (on-demand), so it does not favor either.
- **Prompt diff is the only variable.** The harness must assert that the
  baseline and treatment differ ONLY in the system-prompt Workspace block
  (diff the rendered system prompts and log it).

## Implementation plan (harness changes, no production code changes for stage 1)

1. Add a `--arm` flag to `harness/run.mjs` (`baseline` | `treatment`).
2. For `treatment`, after the agent's system prompt is loaded, inject the
   VFPT map into the `${WORK_DIR_LS}` slot (or append a `## Repository Map`
   block) — done by wrapping the prompt, NOT by editing `system.md` or
   `prompt.ts` (keeps the production package clean; stage 1 is an experiment).
   - Build the map: walk cwd, depth ≤ 2, list files with size (KiB) and dirs
     with entry count, cap at 4 KiB, skip `node_modules`/`.git`/`harness`.
3. Add non-existent-path capture (metric #5) in the `callNormalized` wrapper:
   for each call, test the `path`/`pattern` root against `fs.existsSync`.
4. Extend `results.jsonl` records with `arm` and the new metrics.
5. Extend `analyze.mjs` / `failure-classify.mjs` to group by `arm` and print
   the 10-metric comparison table (baseline vs treatment) with per-query
   breakdown and the 3-repetition distribution.

## Pass / fail criteria (pre-registered)

**VFPT stage 1 is "supported" if, for LFM on Q6/Q8/Q10/Q12:**
- duplicate-exploration count and non-existent-path accesses are **both
  lower** in treatment than baseline (mean over 3 reps, and in ≥2 of 3 reps),
  AND
- accuracy does not drop and total tokens do not increase by more than 10%.

Otherwise: not supported → do not adopt stage 1; revisit stage 2 (file
partitioning) only as a separate question.

## Deliverables

- `harness/vfpt-nav.mjs` — builds the VFPT navigation map (pure function,
  unit-testable).
- Harness run output: `harness/results/vfpt/` (results.jsonl + trajectories).
- `harness/RESULTS-VFPT.md` — the comparison table + verdict.
- README: update the "Future experiment candidate: VFPT" section from
  hypothesis to measured result.
