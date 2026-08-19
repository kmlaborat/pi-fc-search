# pi-fc-search

Pi coding agent extension package for fastcontext repository search.

## Overview

This package integrates fastcontext-style repository search with the pi coding agent, enabling efficient codebase exploration without consuming excessive context tokens. The implementation is written in TypeScript for in-process execution (no external Python process required).

**Design target (v3):** any **general small agentic model** served over an OpenAI-compatible `/chat/completions` endpoint with tool calling — including CPU-served local models. The sub-agent is deliberately read-only (Read/Glob/Grep scoped to the working directory) and model-agnostic; see [docs/SPEC.md §19](docs/SPEC.md#19-v3-general-model-redesign).

Despite its name and origins, this package requires **no Microsoft FastContext model and no fastcontext-specific endpoint** — `fc_search` and the `FASTCONTEXT_*` variables keep the upstream naming for continuity, and any OpenAI-compatible tool-calling model (local or hosted) works; see [Model Selection](#model-selection) below.

### Origin

- **Inspired by / originally ported from**: [manjunathshiva/fastcontext](https://github.com/manjunathshiva/fastcontext), a preserved mirror of Microsoft's removed FastContext repo (arXiv:2606.14066)
- v1/v2 maintained behavioral parity with that Python implementation because the design target was Microsoft's FastContext model. That model was removed from all official repositories and is **no longer the design target** (SPEC §19): prompts, tool descriptions, and sampling defaults were redesigned for general small agentic models, while the tool set, path containment, agent loop, and defensive layers (including Docker-mount path normalization) were retained
- The package still works with community-mirrored MS FastContext models if you prefer them, but no code path assumes them

## Features

- **Natural language search**: Query your codebase with plain English questions
- **Citation mode**: Returns machine-readable `<final_answer>` block with file paths and line ranges (fastcontext `--citation` flag)
- **Context-efficient**: Returns only relevant file locations and summaries
- **Pass-through output**: Final answers returned without wrapper-level truncation
- **No repo pollution**: debug trajectories are written to the OS temp directory (files older than 7 days are auto-removed), never into the searched repository
- **Error handling**: Comprehensive error reporting and recovery
- **Zero external dependencies**: Uses only `@vscode/ripgrep` (all other logic uses Node.js built-ins)

## Installation

### From local directory

```bash
pi install ./path/to/pi-fc-search
```

### From git repository

```bash
pi install git:github.com/kmlaborat/pi-fc-search
```

## Prerequisites

### 1. Node.js Version

Requires **Node.js >= 22.19.0**. This is the minimum version of the host
runtime (`@earendil-works/pi-coding-agent`), not a choice made by this
package — pi-fc-search runs inside pi, so pi's own requirement applies.
Node 20 is end-of-life (2026-04) and cannot host pi. Both current active
LTS lines (Node 22 and Node 24) are tested in CI.

### 2. Ripgrep Dependency

The ported implementation requires one npm dependency:
- `@vscode/ripgrep` - Provides prebuilt ripgrep binary for file searching (bundled, no system PATH required)

> **Note**: No Python, `uv`, or Docker dependencies are required. The implementation runs entirely in TypeScript within the pi agent process.

### 3. Environment Configuration

You can configure environment variables in two ways:

#### Option A: Using .env file (recommended)

Create a `.env` file in the package directory (`pi-fc-search/.env`), which is typically at project root level. It will be loaded automatically at module initialization.

You can start from the provided `.env.example` template:

```bash
cp .env.example .env
# Edit .env with your configuration
```

Example `.env` file (local llama.cpp `llama-server` on its default port):
```
FASTCONTEXT_ENDPOINT="http://127.0.0.1:8080/v1"
FASTCONTEXT_MODEL="InternScience/Agents-A1-4B"
# FASTCONTEXT_API_KEY="..."   # only if your server checks auth
```

#### Option B: Using shell environment variables

```bash
export FASTCONTEXT_ENDPOINT="http://127.0.0.1:8080/v1"
export FASTCONTEXT_MODEL="InternScience/Agents-A1-4B"
# export FASTCONTEXT_API_KEY="..."   # only if your server checks auth
```

> **Note (D-012 — the precedence is the REVERSE of the usual dotenv
> convention, by design)**: If a `.env` file exists in the installed
> package, its values take precedence over shell environment variables. A
> stale `export FASTCONTEXT_...` in your shell or CI profile will be
> **silently ignored** for every key the package `.env` defines — correct
> the `.env` file itself. The `.env` is loaded once when the extension
> starts, so a `.env` edit takes effect on the next pi start (see
> Configuration below). Within a session, the configuration is re-read
> from `process.env` on every `fc_search` call (per-call config
> resolution, D-037; D-054), so fail-fast checks and invalid-value
> warnings always apply to the current values. Shell exports only apply
> to `FASTCONTEXT_*` variables not defined in that `.env` file.

> **Minimal local setup**: serve any OpenAI-compatible model locally, e.g.
> with llama.cpp —
> `llama-server -m /path/to/model.gguf` (serves `/chat/completions` at
> `http://127.0.0.1:8080/v1`) — then set the two `FASTCONTEXT_*` variables
> above. vLLM (default port 8000) and `mlx_lm.server` (macOS) work the same
> way: point `FASTCONTEXT_ENDPOINT` at the server's `/v1` base URL.

### 4. Dependencies

This extension requires exactly one npm dependency:
- `@vscode/ripgrep` - Provides prebuilt ripgrep binary for file searching

All other functionality uses only Node.js built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, global `fetch`).

> **Note**: No Python, `uv`, or Docker dependencies are required. The implementation runs entirely in TypeScript within the pi agent process.

## Usage

### For Users

Once installed, the extension automatically loads and registers the `fc_search` tool.

### For LLM

The LLM can call the `fc_search` tool with the following parameters:

```json
{
  "description": "Find authentication routing",
  "prompt": "Find where the API endpoints are defined and how authentication is handled across the repository."
}
```

### Example Interaction

```
User: Find the authentication middleware in this codebase

LLM calls fc_search tool:
{
  "description": "Find auth middleware",
  "prompt": "Locate the authentication middleware that validates JWT tokens and handles API authentication"
}

Tool response (citation mode) — paths are ABSOLUTE (the system-prompt
contract mandates absolute paths inside `<final_answer>`; D-056, SPEC §18):
### Relevant Files

- **/repo/src/auth/middleware.py**: lines [20-50]
- **/repo/src/api/routes.py**: lines [110-140]

Citation mode returns the machine-readable `<final_answer>` block only:
```
<final_answer>
/repo/src/auth/middleware.py:20-50
/repo/src/api/routes.py:110-140
</final_answer>
```

> **Note**: The sub-agent's final answer **always** ends with a `<final_answer>`
> block (system-prompt contract, D-046). `use_citation: true` returns only that
> block; the default (`false`) returns the full final response — a brief
> explanation followed by the same block.
```

## Configuration

### Environment Variables

The extension reads the following environment variables from the `.env` file at the installed package root or the shell environment (the `.env` file wins over shell variables — the **reverse** of the usual dotenv precedence, see the D-012 note in Installation):

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `FASTCONTEXT_API_KEY` | API key for LLM calls | No | *(empty — fine for local servers that ignore auth)* |
| `FASTCONTEXT_ENDPOINT` | Base URL of any OpenAI-compatible endpoint (`POST /chat/completions` with tool calling) | **Yes** | — |
| `FASTCONTEXT_MODEL` | Model name to use | **Yes** | — |
| `FASTCONTEXT_TEMPERATURE` | Sampling temperature (0–2) | No | `0.2` |
| `FASTCONTEXT_TOP_P` | Nucleus sampling probability (0–1) | No | `0.95` |
| `FASTCONTEXT_MAX_TOKENS` | Max completion tokens per LLM call | No | `32000` |
| `FASTCONTEXT_TIMEOUT_SECONDS` | Total execution timeout (integer ≥ 5). Raise for CPU-served local models | No | `120` |
| `FASTCONTEXT_SEND_MAX_TOKENS` | Send `max_completion_tokens` in requests (`true`/`false`). Set `false` for older OpenAI-compatible servers that 400 on the field (D-052) | No | `true` |

`FASTCONTEXT_ENDPOINT` and `FASTCONTEXT_MODEL` must be set; the tool fails fast with an actionable error if either is missing (SPEC §18/D-005). Invalid numeric values for the sampling/timeout variables warn and fall back to the defaults.

### Model Selection

Any general small agentic model with reliable tool calling works. Pick the smallest one your hardware can serve comfortably — the sub-agent loop (up to `max_turns` LLM calls) multiplies per-call latency.

| Profile | Model | Serving | Notes |
|---------|-------|---------|-------|
| **Recommended (verified)** | `InternScience/Agents-A1-4B` | mlx-lm / vLLM / llama.cpp | Verified across query types: honest exploration (does not fabricate results for non-existent files), accurate answers, good parallel tool calling (SPEC KN-005). Measured comparison below. |
| **CPU-friendly** | `LiquidAI/LFM2.5-2.6B` | llama.cpp / vLLM | Small enough for CPU inference. **Set `FASTCONTEXT_TIMEOUT_SECONDS=600`** (or higher) — CPU latency makes the 120s default unreachable. Keep `FASTCONTEXT_TEMPERATURE` low (default 0.2). Measured: lower accuracy + more turn-budget exhaustion than Agents-A1-4B (see below). |
| **General** | any OpenAI-compatible tool-calling model | any server | If the model wanders or retries failed paths, lower `max_turns` in the `fc_search` call; see KN-001 |

Example recommended configuration:
```
FASTCONTEXT_MODEL="InternScience/Agents-A1-4B"
```

#### Measured comparison (Q8 quantization, llama-swap, 2026-08-18)

The three configurations below were benchmarked against the **pi-fc-search
repository itself** (TypeScript, small–medium) with a fixed set of 13 queries
spanning three categories — **D**irect retrieval, **M**ulti-hop exploration,
and **F**ailure resistance (hallucination / non-existent targets) — plus
re-runs of the failure cases. All runs: `max_turns=15`, `temperature=0.2`,
`top_p=0.95`, a 600 s execution budget (wall time is reported as an
independent metric, not a "practicality" gate). Both Agents-A1-4B variants
served the **same Q8 GGUF** (`Agents-A1-4B-Q8_0.gguf`); thinking was toggled
via `chat_template_kwargs: {enable_thinking: false}` (Qwen3.5-based
mechanism, SPEC KN-005) because the llama-swap model tags were not routed at
benchmark time.

| Config | Model / thinking | D+M correct | F honest | Turn-burn (≥16 turns) | Avg wall | Avg tokens/run |
|--------|------------------|-------------|----------|----------------------|----------|----------------|
| **A1-on** | Agents-A1-4B, thinking **on** | 10–11 / 13 | 1 / 2 | 2 / 13 | 94 s | 85,310 |
| **A1-off** | Agents-A1-4B, thinking **off** | 9 / 13 | 1 / 2 | 2 / 13 | 100 s | 86,355 |
| **LFM** | LFM2.5-2.6B, always thinking | 7 / 13 | 1 / 2 | **7 / 13** | 145 s | 80,870 |

Findings (first pass 39 runs + 9 re-runs; per-query tables and trajectories in
`harness/RESULTS-FIRSTPASS.md`):

- **Accuracy: A1-on ≳ A1-off > LFM.** Thinking-on Agents-A1-4B solved the
  most queries; LFM2.5-2.6B solved the fewest.
- **Stability (turn-budget exhaustion): A1 2/13 vs LFM 7/13.** LFM's smaller
  model size translates into lower exploration efficiency, which hits the
  15-turn budget on most multi-hop queries.
- **The failure modes differ by model family**, which matters for choosing a
  mitigation:
  - **Agents-A1-4B (both) fail by *reaching the right files but not
    producing the final answer*** — the Grep→bounded-Read exploration is
    correct and the ground-truth files are read, but the model re-reads them
    and never emits the `<final_answer>` block before the budget runs out.
    In the single-run first pass this looked like a NOANSWER, but re-runs
    recovered it, so it is variance at the *answer-formation* stage, not a
    broken search.
  - **LFM2.5-2.6B fails by *unable to continue exploring*** — either
    **re-exploring the same spot** (repeated identical `Grep`/`Glob`, and
    `Read` of *non-existent* paths such as `/workspace/...` or `__init__.py`,
    i.e. the KN-001 hallucinated-path pattern) or ending with a **malformed
    tool call** (the raw `<|tool_call_start|>[Read(...)]<|tool_call_end|>`
    string emitted as message *content* instead of structured
    `tool_calls`), which stalls the agent loop.
- **Same-query contrast (Q8, "trace abort-signal → timeout vs cancellation"):**
  A1-off explored in an orderly *test-file entry → Grep-narrow → bounded
  `Read` with explicit `limit`* pattern and answered in 15 turns; A1-on was
  the *most efficient* (10 tool calls) and reached the needed information
  first but did not emit the `<final_answer>`; LFM *stalled on duplicated
  `Glob *` calls and shallow reads* (e.g. `package.json` 163 B, `README.md`
  160 B) and never deep-read the target file, ending in a malformed tool
  call.
- **Thinking on/off:** thinking-on increases completion tokens (more
  `reasoning_content`) and accuracy, but **total tokens stay about the same**
  because prompt (prefill) tokens dominate. Thinking-off is faster per turn
  and in total wall time, and its first-pass NOANSWERs were recovered on
  re-run. Choose thinking-off for speed/token efficiency; thinking-on for the
  highest accuracy where latency is acceptable.
- **Read 64 KiB cap and Grep→bounded Read are working as intended.** All three
  configurations predominantly used the *Grep-to-locate → bounded Read*
  strategy (first tool call was Grep in 9–11/13 runs; LFM in 11/13). Single
  `Read` outputs stayed at or under the 64 KiB cap (SPEC D-048), and the
  combined tool-result budget — **tool-result eviction (SPEC D-047) — never
  fired across all 48 runs** at this repository/query scale: the per-Read 64
  KiB cap bounds each result first, so the running total never exceeded the
  64 KiB budget. We keep the Read cap unchanged and continue to observe.

> **Caveats.** Single repository (this one), single quantization (Q8), one
> server, 13 queries × up to 2 runs — directional, not a large-scale
> benchmark. Q4 quantization would likely reduce accuracy further (not
> tested). LFM's "CPU-friendly, broad user reach" premise is real (it runs
> and answers), but at `max_turns=15` it exhausts the turn budget on most
> multi-hop queries, so that advantage is conditional on raising
> `max_turns` or improving exploration.

#### Future experiment candidate: Virtual File Partition Tree (VFPT)

**Not implemented.** The measured LFM2.5-2.6B failure mode — *wandering the
exploration space* (duplicate `Glob`/`Grep`, repeated `Read` of
non-existent paths, KN-001-style hallucinated paths) — suggests that a
**repository navigation layer** that structures the exploration space up
front (a tree of directories/files with sizes and one-line summaries, i.e. a
Virtual File Partition Tree) could suppress that wandering for small models.
This is a **hypothesis, not yet verified**.

Two distinct effects must not be conflated:

1. **Repository navigation layer** — structure the *space* of files so a
   small model stops guessing paths. This is the unverified hypothesis above
   and the planned first experiment stage (no change to file-content
   partitioning).
2. **Virtual file partitioning** — split *large file contents* for
   hierarchical `Read`. LFM already performs bounded `Read` correctly in the
   benchmark, so this is deferred to a second experiment stage.

Planned first-stage experiment: `baseline` (current fc_search) vs `treatment`
(fc_search + VFPT navigation layer) on LFM2.5-2.6B Q8 over the Q6/Q8/Q10/Q12
multi-hop queries, measuring accuracy, turn count, tool-call count, duplicate
exploration, non-existent-path accesses, duplicate `Glob`, max `Read` size,
total tokens, wall time, and maxTurns-reached rate. See
`harness/RESULTS-FIRSTPASS.md` for the baseline numbers.

#### Context management (large files)

The sub-agent keeps its own prompt bounded for small local models and slow
prefills:

- A single `Read` returns at most **64 KiB**; larger reads end with a
  truncation note telling the model to continue with `offset`/`limit`
  (SPEC D-048).
- The combined size of all tool results in the conversation is kept under a
  **64 KiB budget**: when exceeded, the oldest tool results are replaced by a
  short stub (keeping the `tool_call_id`, tool name/arguments, original size,
  and the first output line) so the model can re-acquire the content
  (SPEC D-047). The full results are always preserved in the trajectory file.

<details>
<summary>Legacy: community-mirrored Microsoft FastContext models (optional)</summary>

If you intentionally use the community-mirrored MS models instead of a general model:

1. FastContext-SFT models (e.g., `FastContext-1.0-4B-SFT`) self-correct their exploration strategy and return accurate answers, with occasional meandering.
2. FastContext-RL models are **not recommended**: they persistently retry non-existent paths up to `maxTurns` and often return fabricated `<final_answer>` content (SPEC KN-003).

The package's Docker-mount path normalization (SPEC §8.5) exists primarily for these models; it is harmless with general models.
</details>

#### Sampling Parameter Notes for Qwen3.5-based Models

- **CoT (Chain of Thought)**: By default, Qwen3.5-based models have CoT enabled (`enable_thinking: true`). When using these models for repository search, set `enable_thinking: false` in your server configuration or API call parameters. Otherwise, the model will consume significant tokens on `<think>` blocks, drastically reducing response speed without meaningful benefit to search quality.
- **Presence Penalty**: Setting `presence_penalty` around 1.5 may help suppress the model's tendency to persistently retry the same (incorrect) path or strategy.
- **Server Configuration**: How to configure `chat_template_kwargs` and sampling parameters varies depending on your server runtime (llama.cpp, vLLM, SGLang, etc.). Refer to your specific server's documentation for the correct configuration method.

> **Note**: `InternScience/Agents-A1-4B` is not an officially supported model of the `fastcontext` project. It has been verified to work as a general-purpose tool calling-compatible model. The model selection above reflects our independent verification, not endorsement by the upstream fastcontext maintainers.

The extension automatically loads environment variables from the `.env` file in the package directory (`pi-fc-search/.env`) at module initialization time.

For local installations (`./path/pi-fc-search`), this is typically the project root level where the package was installed.

**Features:**
- Only built-in Node.js modules used (no external dependencies like `dotenv`)
- Supports `KEY=VALUE` format with optional quotes (`"value"` or `'value'`)
- Lines starting with `#` are treated as comments
- **Only `FASTCONTEXT_*` keys are applied** (SPEC §18/D-018): any other key is
  ignored with a warning, so a stray `PATH=...`-style line can never hijack the
  host pi process
- Failed file reads are silently ignored (does not break execution)
- Parser limitations: no inline comments (`KEY=value # note` keeps the comment as part of the value) and no `export KEY=...` prefix support
- Configuration is read once when the extension loads: after editing `.env`,
  either **restart pi** or run **`/reload-env`** inside a running session.
  The command re-reads `pi-fc-search/.env` and applies its `FASTCONTEXT_*`
  values to the next `fc_search` call, so no restart is needed (SPEC §18/D-057).
  Removing a key from `.env` does not unset it for the current pi process
  (overwrite-only); restart pi to clear a removed key.


### Error Handling

The extension handles the following error cases:

| Error Type | Description | Recovery |
|------------|-------------|----------|
| Missing Parameters | Invalid tool arguments | Provide valid description and prompt |
| Missing Configuration | `FASTCONTEXT_ENDPOINT`/`FASTCONTEXT_MODEL` unset | Set them in `pi-fc-search/.env` (see `.env.example`) or as shell environment variables |
| No Matching Code Found | Search returned no results | Refine search query |
| Turn Budget Exhausted | The model used all `max_turns` (including the forced final turn) without producing a final answer; flagged `isError: true` (D-042) | Re-run with a larger `max_turns` or a more focused prompt |
| LLM API Error | Upstream API failure (transient 408/429/5xx and network errors are retried twice with backoff, D-023); reported with `isError: true` (D-021). A context-window exceedance is retried once automatically with the turn budget halved (D-029) and, if that still fails, reported as an actionable message (D-027) | Check API configuration, retry the search; on context overflow, re-run with a smaller `max_turns` or a more focused prompt |
| Ripgrep binary missing | Bundled binary unavailable | Ensure @vscode/ripgrep is installed |
| Timeout | Operation exceeds `FASTCONTEXT_TIMEOUT_SECONDS` (default 120s) | Raise the timeout for slow/CPU models, simplify query, or retry |
| User Cancellation | Tool call cancelled during execution | Retry if needed |

Missing configuration, timeouts, and other fatal failures are returned as
**flagged error results** (`isError: true`, SPEC §18/D-019), so the host agent
can distinguish a failed search from a (possibly empty) answer. User
cancellation is the only non-error non-answer.

### Troubleshooting: macOS Gatekeeper on the bundled `rg` binary

If a Glob/Grep-based search fails with an OS error mentioning quarantine, `EACCES`, or
`ENOENT` for the `rg` binary (only possible if the binary was copied outside a normal
`npm install`), clear the quarantine attribute:

```bash
xattr -d com.apple.quarantine "$(node -e "console.log(require('@vscode/ripgrep').rgPath)")"
```

A standard `npm install` / `pi install` does not trigger Gatekeeper, so this should not be
needed in practice (SPEC §6).

## Package Structure

```
pi-fc-search/
├── package.json          # Package manifest
├── README.md             # This file
├── .env.example          # Environment variable template
├── extensions/
│   └── index.ts          # Extension entry point (port of fastcontext CLI)
├── src/
│   └── fastcontext-agent/ # Ported from Python implementation
│       ├── agent.ts        # Agent loop
│       ├── llm.ts         # LLM client
│       ├── context.ts     # Trajectory management
│       ├── prompt.ts      # System prompt loader
│       ├── system.md      # System prompt template
│       ├── tools/        # Tool implementations (Read, Glob, Grep)
│       └── index.ts       # Public entry point
├── tests/                # Test infrastructure
│   ├── integration/      # Agent/LLM/env integration suites (mock-based + opt-in real-server)
│   ├── tools/            # Tool test suites
│   └── utils/            # Path utility test suites
└── skills/
    └── pi-fc-search/
        └── SKILL.md      # Skill definition
```

## Development

### Building

No build step required. The package uses TypeScript directly with jiti.

### Testing

```bash
# Run tests with vitest
npm test

# Run type checking
npm run typecheck
```

### Compliance

This extension complies with the following SPEC requirements:

- **Single Dependency**: Only `@vscode/ripgrep` (all other logic uses Node.js built-ins)
- **In-process Execution**: No external Python CLI spawn
- **Output Pass-through**: Final answers returned without wrapper-level truncation
- **Error Handling**: All error types implemented (SPEC §6)
- **Timeout**: Configurable timeout (`FASTCONTEXT_TIMEOUT_SECONDS`, default 120s) with AbortSignal coordination
- **Cancellation**: Cooperative cancellation via AbortSignal (SPEC §4.10)
- **Model-agnostic**: Designed for general small agentic models (SPEC §19)
- **Tests**: Comprehensive test suite with vitest
- **SPEC Version**: Compliant with docs/SPEC.md incl. §17 known issues, §18 documented deviations (D-001 to D-056; D-011 superseded by D-012, the D-019 `LLMAPIError` note superseded by D-021, the D-025 cap value superseded by D-048), and §19 v3 general-model redesign (incl. C-9 context-management guardrails)
- **Transient-failure retry**: LLM API 408/429/5xx and network errors are retried twice with backoff (D-023); LLM API failures and empty final responses are reported as flagged errors (`isError: true`, D-021)

> **Verification**: Full test suite: `npm test` and `npm run typecheck`. The v3 redesign surfaces (prompt, descriptions, sampling/timeout configuration) are covered by `tests/integration/prompt.test.ts` and `tests/integration/config.test.ts`; the context-window auto-retry (D-029) is covered by `tests/integration/context-window-retry.test.ts`.

## Known Issues & TODO

### Known Issues

1. **Halted path exploration**: The model may hallucinate non-existent directory names from file names (e.g., `duet.json` → `duet-js/`) and repeat failed accesses for 10+ turns. 
   - **Mitigated in v3 (prompt-level)**: the v3 system prompt (SPEC §19 C-3) explicitly instructs models to verify a file exists (Glob/Grep) before Read — verified effective with `Agents-A1-4B`.
   - **Proposed programmatic mitigation (still TODO)**: add a hint with the top-level directory listing after N consecutive failures on the same path.

### TODO

- [ ] Implement path failure tracking and corrective hints in tool responses (see Known Issues #1)
- [ ] Remove the temporary `FASTCONTEXT_TIMEOUT_SECONDS=600` mitigation (2026-08-18 prefill-timeout incident) once the local llama-swap parameter filter (which overrides request sampling params) is removed and `tests/integration/timeout-regression.test.ts` passes repeatedly under the default 120s timeout
- [x] Integration test infrastructure for agent execution (mock-based: `tests/integration/history-roundtrip.test.ts`; opt-in real-server: `tests/integration/real-server.test.ts`, runs only when `FASTCONTEXT_ENDPOINT` is set)

## Acknowledgements

This package was originally ported from, and remains inspired by:
- [manjunathshiva/fastcontext](https://github.com/manjunathshiva/fastcontext)
  - Preserved mirror of Microsoft's removed FastContext repo (arXiv:2606.14066)
  - With fixes for local serving on macOS via mlx-lm
- The v3 redesign (SPEC §19) targets general small agentic models; the MS model is no longer a design dependency

## License

MIT
