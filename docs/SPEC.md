# Design Specification: `pi-fc-search` — Native TypeScript Sub-Agent for `pi`

> **Revision note:** This supersedes the original `child_process.spawn("fastcontext", ...)`
> design (external Python CLI wrapper). The exploration sub-agent (LLM loop + Read/Glob/Grep
> tools) is now ported natively into TypeScript and runs **in-process** inside the `pi-fc-search`
> extension. There is no Python, `uv`, or Docker dependency anywhere in this design. Section 0
> explains why; downstream implementation agents should treat this document as the sole source of
> truth and must not resurrect the old spawn-based path.

Downstream implementation agents must not speculate beyond this document. Where exact behavior is
specified below (limits, schemas, truncation rules, message text), it is a **hard requirement**,
not a suggestion — behavioral parity with the original Python `fastcontext` tool (upstream:
`manjunathshiva/fastcontext`, `src/fastcontext/`) is the acceptance bar, not "similar enough."

---

## 0. Purpose and Architecture Overview

### 0.1 Background and Problem

When AI coding agents handle large source code repositories, naively scanning all files or
performing imprecise `grep` operations leads to excessive consumption of LLM context tokens,
resulting in response degradation and reduced code modification accuracy. Particularly in "cold
start states" where the agent doesn't know what exists and where, the problem of agents getting
lost in the codebase frequently occurs.

### 0.2 Solution

Implement a fast repository exploration sub-agent as a native extension package **`pi-fc-search`**
for the `pi` agent environment (Node.js / TypeScript). This frees the main coding agent from the
tedious work of exploring vast codebases, allowing it to focus on pinpointing target lines and
creating modification code.

### 0.3 Why the original Python-CLI-spawn design was replaced

The first implementation called out to a separately installed Python package (`fastcontext`, via
`uv tool install`) as a child process:

```ts
spawn("fastcontext", args, { cwd, env: childEnv, shell: false });
```

This required a working Python 3.12+ + `uv` toolchain to be present and on `PATH` on every machine
that runs `pi`, in addition to Node.js. On Windows in particular this was a common source of
`ENOENT` failures and PATH resolution issues; more generally it doubled the runtime surface area
(two language toolchains) for no functional benefit, since the sub-agent's own logic — an LLM tool
-calling loop plus three filesystem tools — has no inherent Python dependency. The tool also has
**no Docker dependency**; Docker is used only by an unrelated SWE-bench benchmark harness in the
upstream repo and remains out of scope for this package.

### 0.4 Current architecture

> **💡 Language Stack and Dependency Clarification**
> This package is implemented **entirely in TypeScript (Node.js)**. The exploration sub-agent
> (LLM loop, system prompt, Read/Glob/Grep tools) runs in the same process as the `pi` extension
> itself — no external interpreter, no spawned CLI for `fastcontext`. The only subprocess
> dependency is `ripgrep`, used by the Glob/Grep tools exactly as the original Python tool used
> it, now bundled as a platform binary (see §10) instead of assumed to exist on `PATH`.
> To maximize maintainability and lightness, **no external npm modules are used for anything
> other than the bundled ripgrep binary** — all HTTP, parsing, and process-spawning logic uses
> Node.js built-ins (`node:fs`, `node:path`, `node:child_process`, global `fetch`).

**Before (superseded):**
```
pi (Node) --spawn--> fastcontext CLI (Python process)
                        └─ LLM calls (OpenAI-compatible)
                        └─ rg subprocess (Glob/Grep tools)
                        └─ file reads (Read tool)
```

**After (this spec):**
```
pi (Node) --function call--> fastcontext-agent (TS module, same process)
                                └─ LLM calls (fetch, OpenAI-compatible)
                                └─ rg subprocess (Glob/Grep tools — via bundled ripgrep binary)
                                └─ file reads (Read tool, node:fs)
```

---

## 1. Directory / File Layout

```
.
├── extensions/
│   └── index.ts                  # calls runFastContextAgent() directly; no spawn()
├── src/
│   └── fastcontext-agent/
│       ├── agent.ts              # agent loop (port of agent.py)
│       ├── llm.ts                # OpenAI-compatible chat completions client (port of llm.py)
│       ├── context.ts            # message history + trajectory JSONL writer (port of context.py)
│       ├── prompt.ts             # system prompt template loader (port of utils.py + system.md)
│       ├── system.md             # verbatim ported system prompt template
│       ├── tools/
│       │   ├── types.ts          # Tool interface, ToolResult, ToolSet (port of tool.py)
│       │   ├── read.ts           # port of read.py + read.md
│       │   ├── glob.ts           # port of glob.py + glob.md
│       │   └── grep.ts           # port of grep.py + grep.md
│       └── index.ts              # public entry point: runFastContextAgent(...)
├── package.json                  # only dependency: @vscode/ripgrep (see §10)
└── skills/pi-fc-search/SKILL.md  # unchanged (external contract does not change)
```

---

## 2. Input Specifications (Inputs & Constraints)

### 2.1 Extension / Tool Input Parameters (JSON Schema)

Unchanged from the original design — the swap from spawned-CLI to in-process TS is an internal
implementation detail and must not alter what the main agent sends:

```json
{
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "Short task description (3-5 words, e.g., 'Find API auth middleware')",
      "maxLength": 100
    },
    "prompt": {
      "type": "string",
      "description": "Detailed natural language instruction or question for repository exploration.",
      "maxLength": 2000
    },
    "max_turns": {
      "type": "integer",
      "description": "Maximum number of search turns. Default is 15 for thorough exploration.",
      "minimum": 1,
      "maximum": 50
    },
    "use_citation": {
      "type": "boolean",
      "description": "Enable citation mode (output only file paths and line numbers). Default is false for full context with summaries."
    }
  },
  "required": ["description", "prompt"]
}
```

### 2.2 System Environment Prerequisites and Constraints

1. **Runtime Environment**: Node.js only. There is no `fastcontext` CLI to install or discover on
   `PATH` — the sub-agent runs as a TypeScript module inside the `pi-fc-search` package itself.
   Ripgrep is bundled (§10.1); no separate installation step is required for it either.
2. **Working Directory (cwd)**: The agent must be invoked with `cwd` set to the root directory of
   the target repository for exploration. All three tools (Read/Glob/Grep) are scoped to this
   directory (§11).
3. **Authentication Environment Variables**: Environment variables required for the sub-agent's
   own LLM API calls must be configured. The extension supports multiple configuration methods:
   - Shell environment variables (exported before running `pi`)
   - `.env` file (automatically loaded at module initialization)

   The extension automatically loads `.env` from the package directory at module initialization time:
   - Package directory (`pi-fc-search/.env`) — typically project root level where the package is installed

   **Environment Variable Mapping** (naming convention unchanged from the original design, to
   avoid a breaking change for existing `.env` files — only the *consumer* changes, from a child
   process's `env` object to a plain in-process config object passed to `llm.ts`):
   - `FASTCONTEXT_API_KEY` → `RunFastContextAgentOptions.llm.apiKey`
   - `FASTCONTEXT_ENDPOINT` → `RunFastContextAgentOptions.llm.baseUrl`
   - `FASTCONTEXT_MODEL` → `RunFastContextAgentOptions.llm.model`

   **Environment Variable Mapping** (naming convention unchanged from the original design, to
   avoid a breaking change for existing `.env` files — only the *consumer* changes, from a child
   process's `env` object to a plain in-process config object passed to `llm.ts`):
   - `FASTCONTEXT_API_KEY` → `RunFastContextAgentOptions.llm.apiKey`
   - `FASTCONTEXT_ENDPOINT` → `RunFastContextAgentOptions.llm.baseUrl`
   - `FASTCONTEXT_MODEL` → `RunFastContextAgentOptions.llm.model`

   This mapping prevents conflicts when the same environment is used by other projects.
4. **Dependency policy**: `@vscode/ripgrep` is the **only** npm dependency permitted (§10). All
   other input/output validation, parsing, HTTP calls, and formatting must use only Node.js
   standard libraries (`node:fs`, `node:path`, `node:child_process`, `node:crypto`) and the
   built-in `fetch`. No `axios`, `lodash`, `zod`, `dotenv`, `openai` SDK, etc.

---

## 3. Output Specifications (Outputs & Guarantees)

### 3.1 Output Data Structure

The tool returns the **agent's final answer text**, unmodified, matching the original CLI's
stdout semantics exactly. The format depends on the `use_citation` parameter:

**Default mode (`use_citation: false`):**
Returns full natural language response with summaries, reasoning, and file contexts:
```markdown
Based on my analysis of the repository structure...

Key files found:
- Authentication middleware at `src/auth/middleware.py` (lines 20-50)
  - Handles JWT token validation
  - Implements role-based access control
- API routing at `src/api/routes.py` (lines 110-140)
  - Defines all REST endpoints
  - Integrates with authentication layer
```

**Citation mode (`use_citation: true`):**
Returns only the `<final_answer>` block, extracted via the same regex logic as the original
`get_final_answer` in `utils.py` (see §9, Requirement B):
```
<final_answer>
src/auth/middleware.py:20-50
src/api/routes.py:110-140
</final_answer>
```

The main agent receives this text directly. No additional formatting or tag manipulation is
applied by the wrapper.

### 3.2 Output Handling — Pass-Through Design

**No truncation or processing is applied to the final answer returned to the caller.** (Internal
tool outputs, i.e. what Read/Glob/Grep return *to the LLM* during the exploration loop, do have
the specific truncation limits defined in §8 — that truncation is part of the original tool's
behavior and must be preserved. It is the *final* answer handed back to `pi` that is never
truncated.)

> **🔧 Design Rationale**
> Earlier iterations of the wrapper considered output truncation (2000 lines / 50KB limits) and
> smart trimming on the final answer to preserve code blocks. This processing was identified as a
> source of hallucination and confusion for the main agent. The current pass-through design
> eliminates all such processing on the final answer to provide the agent with complete,
> unfiltered information.

### 3.3 Guarantees

1. All output file paths must be relative paths from `cwd` at execution time, or valid absolute
   paths.
2. The line ranges presented must be valid line numbers actually existing in the target file.

---

## 4. Invariants

The following conditions must always be maintained throughout the tool's execution lifecycle.

1. **State Isolation**: Execution must not make any changes to the code in the repository, the
   state of the file system, or the Git history (strictly read-only behavior).
2. **High Consistency**: For the same repository state and same `prompt` input, setting the
   underlying LLM's `temperature` low should maximize the consistency of returned file lists and
   context (minimal differences due to the probabilistic nature of LLMs are permitted).
3. **Non-blocking Concurrency**: Even during execution of this tool, the main agent must not be
   prevented from executing other read operations concurrently in the same environment.
4. **Single-process invariant**: No `child_process.spawn` of a Python interpreter or any
   `fastcontext` CLI anywhere in the implementation. The only permitted subprocess is `rg`
   (ripgrep), spawned by the Glob/Grep tools.
5. **Ripgrep-bundling invariant**: The `rg` binary used by Glob/Grep must come from the bundled
   `@vscode/ripgrep` dependency (§10), never from an assumption that `rg` is on the user's system
   `PATH`. System `PATH` may be used only as a fallback, never as the primary path.
6. **Behavioral parity invariant**: Tool JSON schemas, truncation limits, permission checks, and
   system prompt content must match the original Python implementation exactly, per §8–§9, unless
   explicitly marked as changed in this document.
7. **External contract invariant**: The `fc_search` tool's name, `parameters` JSON schema (§2.1),
   and `content`/`isError` return shape registered via `pi.registerTool(...)` in
   `extensions/index.ts` must not change from the original design. Only the internal execution
   path changed.
8. **No templating-library dependency**: The system prompt uses only `${VAR}` substitution (§9.4)
   — implement with a trivial string-replace, not a templating library (no Jinja2 equivalent
   needed).
9. **Working-directory containment invariant**: Read/Glob/Grep must refuse to operate outside the
   `cwd` passed in by the caller, using path comparison that is correct on Windows (drive letters,
   case-insensitivity, backslash vs forward-slash) — see §11.
10. **Cancellation invariant**: The agent must respect the `AbortSignal` passed in from
    `pi.registerTool(...).execute(...)`, cancelling in-flight LLM `fetch` calls and stopping before
    the next turn. Because there is no child process to `SIGKILL` anymore, cancellation must be
    cooperative (checked between turns and threaded into `fetch`'s `signal` option).

---

## 5. Public API (replaces the old `executeFastcontext` spawn wrapper)

```ts
// src/fastcontext-agent/index.ts
export interface RunFastContextAgentOptions {
  prompt: string;
  cwd: string;                 // absolute path, working directory the agent is scoped to
  maxTurns?: number;           // default 15
  citation?: boolean;          // default false — if true, return only the <final_answer> block
  trajectoryFile?: string;     // default: `${cwd}/.fastcontext/trajectory_<timestamp>.jsonl`
  signal?: AbortSignal;
  llm: {
    model: string;
    apiKey: string;
    baseUrl: string;
    temperature?: number;      // default 1.0
    topP?: number;             // default 0.95
    maxTokens?: number;        // default 32000
  };
  verbose?: boolean;
}

export async function runFastContextAgent(
  options: RunFastContextAgentOptions
): Promise<string>; // returns final answer text, matching original CLI stdout semantics
```

`extensions/index.ts` calls this directly. There is no `TIMEOUT_SECONDS`/`spawn`/stdout-stderr
collection logic; the 120s timeout is implemented as a `Promise.race` / `setTimeout` around the
direct function call, still **resolving** (not rejecting) with the message shape from §6, so
`pi`'s tool-result formatting does not need to change.

---

## 6. Exception Handling (Failure Cases)

In the `extensions/index.ts` handler layer, capture errors from `runFastContextAgent(...)` and
return them to the `pi` runtime in the following format.

| Occurrence Condition | Expected System Behavior / Returned Error Format |
| --- | --- |
| **Missing Parameters** | Error detected by `pi` runtime validation (JSON Schema) or by `validateInput` in §12. Prompt for re-request to LLM or return `Invalid tool arguments`. |
| **No Matching Code Found** | Normal completion and return of the agent's own natural-language "nothing found" answer. The main agent interprets it directly — this is not a wrapper-level error case. |
| **LLM API Error / Endpoint Unreachable** | The agent loop captures the fetch failure, appends an assistant message describing it, and returns that message as the final output rather than throwing out of `runFastContextAgent`. |
| **Ripgrep binary missing for current platform/arch** | Fall back to system `PATH` resolution of `rg`; if that also fails, the Glob/Grep tool call returns a `failed: true` `ToolResult` with a clear message. Never throw uncaught, never crash the `pi` extension host. |
| **macOS Gatekeeper / `com.apple.quarantine` on the bundled `rg` binary** | Glob/Grep tool call fails with a clear, actionable message (surface the OS error text) rather than hanging or producing an opaque `ENOENT`/`EACCES`. Document the `xattr -d com.apple.quarantine <path>` fix in the README; note this should not occur via a normal `npm install`. |
| **Timeout** (exceeding 120 seconds) | `Promise.race` resolves with:<br><br>`[ERROR] pi-fc-search execution timeout exceeded (120 seconds).`<br><br>No process to `SIGKILL` — the in-flight LLM `fetch` is aborted via the same `AbortSignal` mechanism as user cancellation (§4.10). |
| **`AbortSignal` fires mid-turn (user/pi cancels the tool call)** | In-flight `fetch` is aborted, the agent loop stops before starting a new turn. `runFastContextAgent` rejects with `Error("Operation was cancelled")`, caught in `extensions/index.ts`'s `execute()` and converted to a non-error `content` response — preserving the original UX. |

---

## 7. Acceptance Tests

### 7.1 Test Case 1: Happy Path (Authentication Processing Exploration)

* **Input** (default mode with full context):
```json
{
  "description": "Find authentication routing",
  "prompt": "Find where the API endpoints are defined and how authentication is handled across the repository."
}
```

* **Expected Output** (agent's own answer text — varies by model response, but structurally):
```markdown
Based on my analysis of the repository structure, authentication is processed via a custom middleware that validates JWT tokens.

Key files:
- `src/auth/middleware.py` (lines 20-50) - Handles JWT validation and role-based access
- `src/api/routes.py` (lines 110-140) - Defines REST endpoints with auth integration
```

* **Pass Condition**: Output contains meaningful context about authentication, includes file paths
  with line numbers, and matches the shape the sub-agent's `system.md` (§9.4) instructs it to
  produce. The main agent receives **unmodified output** and interprets it directly.

### 7.2 Test Case 2: Exception Path (LLM Endpoint Unreachable)

> Supersedes the old "CLI not found on PATH" test case, which no longer applies since there is no
> external CLI to find.

* **Mock Environment**: Point `llm.baseUrl` at an unreachable/refused address.
* **Input**:
```json
{
  "description": "Trigger failure test",
  "prompt": "Locate anything."
}
```
* **Expected Output**: The agent's captured-failure message (§6, "LLM API Error / Endpoint
  Unreachable" row) rather than an uncaught rejection or a `pi` extension-host crash.
* **Pass Condition**: The `execute()` handler in `extensions/index.ts` returns a non-error
  `content` response describing the failure; the process does not throw uncaught.

### 7.3 Test Case 3: Tool-Output Truncation Verification

* **Input**: A query expected to trigger a Glob/Grep call producing more than the tool-level
  truncation limits in §8 (e.g. >100 Grep matches).
* **Expected Output**: The intermediate `Grep`/`Glob` tool result (visible in the trajectory file,
  not necessarily in the final answer) contains the exact truncation message text from §8.2/§8.3.
* **Pass Condition**: Truncation limits and message text match §8 exactly; the *final answer*
  handed back to the caller is still never truncated by the wrapper itself (§3.2).

### 7.4 Test Case 4: In-Process Integration (No Spawn)

* **Setup**: Spy/stub on `child_process.spawn`.
* **Pass Condition**: Invoking the `fc_search` tool never calls `spawn` for anything named
  `fastcontext` or any Python interpreter. `spawn` may only be observed being called with the
  bundled `rg`/`rg.exe` path (§10.1), for Glob/Grep tool calls.

### 7.5 Test Case 5: Cross-Platform (Windows / macOS / Linux)

Run the full `fc_search` tool end-to-end on all three target OSes with no Python installed and no
`rg` on `PATH`, against a repo containing paths with spaces:
- **Windows:** working directory under a drive letter other than `C:`. Must succeed.
- **macOS:** working directory under a path containing non-ASCII characters; verify the bundled
  `rg` binary is not blocked by Gatekeeper on first run (§6).
- **Linux:** run on both `x64` and `arm64` runners if available.

In all three cases, result output must be structurally identical (same truncation limits, same
message text) for equivalent fixture inputs — no OS-specific branches in the tool/agent code
should be needed to achieve this. See §12 (Requirement D) for the CI implementation strategy.

---

## 8. Tool Ports — Exact Behavioral Specs

### 8.1 Read tool (port of `read.py`)

- **name**: `Read`
- **parameters**: `{ path: string (required), offset?: integer, limit?: integer }`
- **description**: verbatim content of `read.md` (§9.3), loaded at module init, not re-authored.
- **Behavior**:
  - If `path` missing/empty → `"Read Tool: file path is required."`
  - If file does not exist → `` `Read Tool: file ${file_path} does not exist.` ``
  - Read as UTF-8 text, split into lines.
  - If file has 0 lines → `"File is empty."`
  - `offset` is 1-indexed; if `undefined` or `< 0`, treat as `1`.
  - `limit`, if given, computes `end_line = offset + limit - 1`, clamped to file length.
  - **MAX_LINE = 2000**: total returned lines are capped at 2000 (from the effective `offset`),
    with a literal `"..."` line appended if truncated.
  - **MAX_LINE_LENGTH = 2000**: any single line longer than 2000 chars is cut to 2000 chars with
    `"...\n"` appended. (Note: `read.md`'s prose says "500 characters" — the *code* enforces 2000.
    Port the code's actual limit, 2000; do not follow the stale docstring number.)
  - Each returned line is prefixed `${lineNumber}|${lineContent}`.
  - Final output wrapped as:
    ```
    ```${file_path}:${offset}-${end_line}
    ${content}
    ```
    ```
    (triple-backtick fenced block, exactly as the Python version does)

### 8.2 Glob tool (port of `glob.py`)

- **name**: `Glob`
- **parameters**: `{ directory?: string, pattern: string (required) }` — `directory` defaults to
  the tool-call's `cwd`.
- **description**: verbatim content of `glob.md` (§9.1).
- **Behavior**:
  - Reject if `directory` is not an existing directory.
  - Reject with `` `Permission error: \`${directory}\` is not within the working directory \`${cwd}\`.` ``
    if `directory` resolves outside `cwd` (see §11 for correct Windows path containment logic).
  - Run: `rg --files ${directory} --glob ${pattern}` with `cwd` as the subprocess cwd, using the
    bundled `rgPath` (§10.1), 10s timeout.
  - On timeout: `` `Tool \`Glob\` timed out after 10s.` ``
  - On non-zero exit: return stderr text.
  - Split stdout into lines; cap to **first 100 matches**, appending
    `` `Results are truncated: showing first 100 results. Consider using a more specific path or pattern.` ``
    if truncated.
  - If zero matches → `"No files found"`.

### 8.3 Grep tool (port of `grep.py`)

- **name**: `Grep`
- **parameters** (exact JSON Schema, port field-for-field):
  ```json
  {
    "type": "object",
    "properties": {
      "pattern": { "type": "string" },
      "path": { "type": "string" },
      "glob": { "type": "string" },
      "output_mode": { "type": "string", "enum": ["content", "files_with_matches", "count"] },
      "-B": { "type": "number" },
      "-A": { "type": "number" },
      "-C": { "type": "number" },
      "-n": { "type": "boolean" },
      "-i": { "type": "boolean" },
      "type": { "type": "string" },
      "head_limit": { "type": "number", "minimum": 0 },
      "multiline": { "type": "boolean" }
    },
    "required": ["pattern"]
  }
  ```
  (descriptions of each field: copy verbatim from `grep.py`'s `parameters` dict.)
- **description**: verbatim content of `grep.md` (§9.2).
- **Defaults**: `path` defaults to `cwd`; `-C` (context) defaults to `3`; `-n` (line numbers)
  defaults to `true`; `output_mode` has no hardcoded default in the schema but downstream
  ripgrep-arg-building only adds `--files-with-matches`/`--count-matches`/content-flags based on
  the value provided — port the `run_rg` arg-building logic 1:1 including the
  `output_mode === "count_matches"` string (note: this is inconsistent with the schema enum value
  `"count"` in the original Python — preserve this exact inconsistency rather than "fixing" it,
  since fixing it is a behavior change out of scope for this port; flag it in code comments as a
  known upstream quirk).
  - Reject if `path` resolves outside `cwd` (same containment check as Glob, §11).
  - Always append `--heading --color never` to the `rg` invocation.
  - Cap output to **100 lines** by default; if `head_limit` is provided and
    `0 < head_limit < 100`, use `head_limit` instead. Append
    `` `Results truncated to first ${limit} lines` `` when truncated.
  - Empty output → `"No matches found"`.

### 8.4 ToolSet (port of `tool.py`)

- Each tool call has a **10-second timeout** (`MAX_TOOLRUN_TIMEOUT`). On timeout, return a
  `ToolResult` with `failed: true` and
  `` `Tool \`${name}\` timed out after 10s.` ``, not a thrown exception.
- Unknown tool name → `failed: true`, `` `Tool \`${name}\` not found.` ``
- Invalid JSON arguments → `failed: true`, `` `Tool \`${name}\` arguments are invalid.` ``
- Any thrown error inside a tool's `call()` → caught, `failed: true`, `output: String(error)`.
- Multiple tool calls in one LLM turn are processed **sequentially** in the original (the `_call`
  future-wrapping is a vestige, not actually parallel — see the commented-out
  `asyncio.create_task` line). You may parallelize with `Promise.all` in the TS port **only if**
  you keep per-call error isolation and the 10s-per-call timeout; note this as an intentional
  improvement over upstream, not a silent behavior change.

---

## 9. System Prompt & Tool Descriptions

Port these four files **verbatim** (content is provided here so the implementing agent does not
need to re-derive it):

### 9.1 `glob.md`
```
- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.
```

### 9.2 `grep.md`
```
A powerful search tool built on ripgrep
Usage:
- Prefer using Grep for search tasks when you know the exact symbols or strings to search for. Whenever possible, use this tool instead of invoking grep or rg as a terminal command.
- Supports full regex syntax (e.g., "log.*Error", "function\s+\w+")
- Filter files with glob parameter (e.g., ".js", "**/.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use interface\{\} to find interface{} in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like struct \{[\s\S]*?field, use multiline: true
- Results are capped to several thousand output lines for responsiveness; when truncation occurs, the results report "at least" counts, but are otherwise accurate.
- Content output formatting closely follows ripgrep output format: '-' for context lines, ':' for match lines, and all context/match lines below each file group.
```

### 9.3 `read.md`
```
Reads a file from the local filesystem. You can access any file directly by using this tool.
If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive 'File is empty.'
- Any lines longer than 500 characters will be truncated to 500 characters with '...' appended to the end.
- Any file content that exceeds the 2000 lines will be truncated to 2000 lines with '...' appended to the end.
```
(As noted in §8.1, the *code* truncates lines at 2000 chars, not 500 — port code behavior, keep
this docstring text unchanged since it is model-facing prose, not a spec for your implementation.)

### 9.4 `system.md` (Jinja2 `${VAR}` syntax → plain string substitution)
```
You are a codebase exploration specialist focused exclusively on searching and analyzing existing code.
Your main goal is to explore the codebase based on a query, which are denoted by the <query> tag.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files


## Required Output

End your response with an optional brief explanation of your findings (no more than 50 words), followed by a `<final_answer>` tag containing the relevant file paths and line ranges.

<example>
The core routing logic lives in two files.

<final_answer>
/absolute/path/to/file_1.py:10-15 (Optional Brief Reason: e.g., "Core logic to modify")
/absolute/path/to/file_2.js:102-123
</final_answer></example>

## Working Environment

OS Version: ${OS_KIND}

Shell: ${SHELL_NAME}

Workspace Path:${WORK_DIR}

The directory listing of the workspace is:
${WORK_DIR_LS}
```
Substitution variables: `OS_KIND` (Node: `process.platform`, e.g. `"win32"`/`"darwin"`/`"linux"` —
acceptable to differ in exact string from Python's `platform.system()` output, since this is
informational text for the LLM, not a parsed value), `SHELL_NAME` (`process.env.SHELL` if set,
else `"bash"` fallback — on Windows this env var is typically unset, which is fine, the fallback
still applies), `WORK_DIR` (the `cwd` passed in), `WORK_DIR_LS` (newline-joined
`fs.readdirSync(cwd)` — top-level entries only, matching `os.listdir` semantics, not recursive).

---

### 10.4 Docker-mount absolute path resolution (FastContext model compatibility)

FastContext models trained in SWE-bench-like environments with Docker mounts frequently produce
tool-call path arguments that are not real filesystem paths but "relative to repo root" intents:

```json
// FastContext output pattern (not a real filesystem path):
{"path": "/pi-fc-search/package.json", ...}
```

This is not an error — the model learned these patterns during training in `/repo-name/` mount
environments. The implementation must attempt to resolve such paths by trying multiple candidate
strategies, as follows.

**Resolution function: `resolveDockerMountPath(originalPath, cwd)`**

| Strategy | Description | Example |
|---|---|---|
| 1 | Direct resolution if already within cwd | `/workspace/...` stays as-is |
| 2 | Strip leading `/`, treat as relative to cwd | `/package.json` → `./package.json` |
| 3 | Strip `/\<cwd-basename\>/` prefix (mount style) | `/pi-fc-search/package.json` → `./package.json` |
| 4 | Match and strip any leading component equal to cwd basename | Recursive scan of path components |

**Return value:** `{ resolved: string, correction?: string }` on success, `null` if unresolvable.
If a transformation was applied, include a correction note for tool output.

**Example usage in tools (read.ts pattern):**
```typescript
const absoluteCwd = ctx.cwd;
let resolvedPath: string;
let pathCorrection: string | undefined;

const dockerResolution = resolveDockerMountPath(filePath, absoluteCwd);
if (dockerResolution) {
  resolvedPath = dockerResolution.resolved;
  pathCorrection = dockerResolution.correction;
} else {
  resolvedPath = resolve(filePath); // standard fallback
}

// isWithinCwd check applies AFTER correction to the final resolved path
```

This function must be called before `isWithinCwd` validation in Read, Glob, and Grep tools.
When a correction succeeds, tools may prepend `[Path corrected from X to Y]` to their output,
of which example is:
```typescript
correctionNote = pathCorrection ? `[${pathCorrection}]\n` : "";
```

## 10. Dependencies (`package.json`)

The `pi-fc-search` package has exactly **one** npm dependency:

### 10.1 `@vscode/ripgrep`

Provides a `rgPath` export resolving to a platform-correct `rg`/`rg.exe` binary.

Package characteristics (important for implementation agents): the npm tarball includes
per-platform binaries directly; there is no postinstall network download and no runtime network
access is required. `optionalDependencies` point at `@vscode/ripgrep-<os>-<cpu>` packages that are
resolved at install time.

```ts
import { rgPath } from "@vscode/ripgrep";
// child_process.spawn(rgPath, [...])
```

Use `rgPath` as the primary binary path for Glob/Grep; fall back to system `PATH`-resolved `rg`
only if the bundled binary is somehow unavailable, and log a warning in that fallback case (§6).

**Why `@vscode/ripgrep` over alternatives:**

| Option | Verdict |
|---|---|
| **@vscode/ripgrep (recommended)** | Binaries bundled in tarball, no network required, Windows/macOS/Linux × x64/arm64 supported, used by VS Code |
| `@vscode/ripgrep-universal` | All platforms in one ~60MB package — only for build hosts packaging for multiple targets; not needed since `pi-fc-search` is installed directly on the execution environment |
| System `PATH` `rg` | The problem being solved by bundling; reject as primary source |
| Custom script to fetch releases | Reinventing what `@vscode/ripgrep` does; higher maintenance burden |

### 10.2 No LLM SDK dependency

Plain `fetch` against the OpenAI-compatible `POST {baseUrl}/chat/completions` endpoint is
sufficient and keeps the dependency footprint minimal, consistent with this package's stated
zero-dependency philosophy (beyond ripgrep). If the implementing agent prefers the `openai` npm
package for correctness around edge cases (tool-call streaming deltas, etc.), that is acceptable
but must be justified in a code comment, since it breaks the single-dependency invariant.

**Tool-call id synthesis**: some OpenAI-compatible servers (mlx-lm and others) return tool calls
with `id: null`. The implementation must synthesize ids when omitted (format: `call_{uuid}`,
matching the upstream fix in the original repo). Without this, the agent crashes on its first tool
call against such servers.

---

### 11. Tool-call round-trip invariant: raw message objects must not be transformed for history storage

When storing LLM responses in conversation history:

1. The **raw `message` object returned by the server** (including its nested `{id, function: {name, arguments}}` structure) is stored directly in the `messages` array without modification.
2. A **normalized flat struct** ({id, name, arguments}) may be derived temporarily for tool execution but must not be written back into history or the next API request — this breaks the transformation chain that caused the "function field disappears" bug (see §10.4 for details).
3. If a server returns `tool_call.id: null`, synthesize an id (`call_{uuid}`) on the raw object itself before storing, rather than creating a new transformed struct.

This invariant is maintained by:
- `llm.ts`: `extractRawMessage()` returns both the unmodified raw object and a derived normalized tool-call list
- `context.ts`: stores raw objects directly; never derives FunctionCall structs from history
- `agent.ts`: uses normalized tool calls only for temporary execution via `toolset.callNormalized()`

## 12. Windows-Correct Path Containment (replaces Python's `Path.is_relative_to`)

The original Python tools reject paths outside `cwd` using `Path(x).resolve().is_relative_to(Path(cwd).resolve())`.
Do **not** port this with naive string prefix checks (`path.startsWith(cwd)`), which breaks on
Windows for two reasons: (a) drive-letter case differences (`c:\...` vs `C:\...`), and (b) sibling
directories with a shared prefix (`C:\proj` vs `C:\project2`). Implement containment as:

```ts
import * as path from "node:path";

function isWithinCwd(candidate: string, cwd: string): boolean {
  const resolvedCwd = path.resolve(cwd);
  const resolvedCandidate = path.resolve(cwd, candidate);
  const rel = path.relative(resolvedCwd, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
```
Use `path.relative` + `path.isAbsolute` (both Windows-aware in Node's `path` module), never manual
`/`-splitting or string slicing on the raw path.

---

## 12. TDD Task Breakdown

Implement and verify in this order; do not reorder.

### Requirement A: Tool parity
**Acceptance Test:** For a fixture directory, `Read`/`Glob`/`Grep` TS implementations produce
byte-identical output to the Python originals for: (1) a normal file read, (2) an out-of-range
`offset`, (3) a glob with >100 matches (verify truncation message), (4) a grep with
`output_mode: "content"` and `-C 3`, (5) a path-containment violation for all three tools.
**Implementation Strategy:** Port §8.1–§8.4 exactly; write fixtures under a `__fixtures__/` dir
committed to the package for repeatable testing.

### Requirement B: Agent loop parity
**Acceptance Test:** Given a mocked LLM client that returns a scripted sequence of tool calls then
a final answer, the agent loop (a) writes one JSONL line per message to the trajectory file, (b)
stops at `max_turns` with the exact original message
`` `No final answer after ${max_turns} turns.` `` when no final answer is reached, (c) with
`citation: true`, returns only the `<final_answer>...</final_answer>` block via a regex extraction
identical to `get_final_answer` in `utils.py`.
**Implementation Strategy:** Port `agent.ts`/`context.ts` from `agent.py`/`context.py` 1:1,
including the turn-counting off-by-one behavior (`n_turn > max_turns + 1` and the
`n_turn == max_turns + 1` "please provide final answer" injection).

### Requirement C: In-process integration
**Acceptance Test:** `extensions/index.ts`'s `fc_search` tool, when invoked, no longer spawns any
child process for `fastcontext` itself (verify via a test that stubs/spies on `child_process.spawn`
and asserts it is not called for this purpose — see §7.4), and returns output structurally
equivalent to the original `executeFastcontext` return value for the same inputs.
**Implementation Strategy:** Replace the `executeFastcontext` function body with a call to
`runFastContextAgent(...)` (§5); keep `validateInput` (§13), the tool schema (§2.1), `onUpdate`
progress reporting, and the `pi.registerTool(...)` registration unchanged.

### Requirement D: Cross-platform verification (Windows / macOS / Linux)
**Acceptance Test:** See §7.5.
**Implementation Strategy:** CI matrix job across `windows-latest`, `macos-latest`, and
`ubuntu-latest` (plus an `arm64` Linux runner if available in CI), each with `PATH` scrubbed of
any Python install, running the Requirement A–C test suites unmodified on each OS. A single test
suite running unchanged on all three legs is itself part of the acceptance bar — if a leg needs
OS-conditional test code, treat that as a signal the implementation leaked an OS-specific
assumption and fix the implementation, not the test.

---

## 13. Process Execution Security Design (Ripgrep Subprocess Only)

The only remaining subprocess in this design is `rg` (ripgrep), spawned by the Glob/Grep tools.
The same guidelines that previously applied to spawning the `fastcontext` CLI now apply to it:

* **Prohibition of Shell Execution**: **Strictly prohibit** the use of `child_process.exec` and
  specifying `shell: true` in `spawn` when invoking `rg`.
* **Argument Array Passing**: Pass patterns/paths containing user input directly to the OS in
  array format without going through the shell.
* **Standard Validation**: Ensure input safety using only JavaScript standard type checks and
  string operations (`typeof`, regular expressions) — no external validation library (§2.2.4).

**Top-level input validation** (unchanged from the original design, still required at the
`extensions/index.ts` boundary before constructing `RunFastContextAgentOptions`):

```typescript
function validateInput(args: any): { description: string; prompt: string } {
  if (!args || typeof args !== 'object') {
    throw new Error('Invalid tool arguments');
  }
  const { description, prompt } = args;
  if (typeof description !== 'string' || description.length > 100) {
    throw new Error('Invalid or missing description');
  }
  if (typeof prompt !== 'string' || prompt.length > 2000) {
    throw new Error('Invalid or missing prompt');
  }
  return { description, prompt };
}
```

**Ripgrep spawn pattern** (used inside `tools/glob.ts` and `tools/grep.ts`):

```typescript
import { spawn } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';

const child = spawn(rgPath, ['--files', directory, '--glob', pattern], {
  cwd,
  shell: false,
});
```

---

## 14. Environment Configuration and `.env` File Support

Unchanged in mechanism from the original design; only the consumer of the resulting values changed
(§2.2.3).

### 14.1 `.env` File Format

```env
# API key for the sub-agent's LLM calls (optional)
FASTCONTEXT_API_KEY=your-api-key-here

# Base URL of the LLM endpoint (optional)
FASTCONTEXT_ENDPOINT=https://your-fastcontext-endpoint.com

# Model name to use for the sub-agent (optional)
FASTCONTEXT_MODEL=fastcontext-model-name
```

### 14.2 `.env` File Loading Implementation

Loaded using only Node.js built-in modules (no external dependencies like `dotenv`):

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function loadEnvFile(): void {
  // Package directory only — matches both local and git installations
  const envPath = resolve(dirname(import.meta.url), '..', '..', '.env');

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    
    for (const line of lines) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        const lines = content.split(/\r?\n/);
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();
            
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            
            process.env[key] = value;
          }
        }
      } catch (e) {
        // Silently fail if .env file can't be read
      }
    }
  }
}

// Load environment variables at module initialization
loadEnvFile();
```

### 14.3 Environment Variable → `RunFastContextAgentOptions.llm` Mapping

```typescript
const llmOptions: RunFastContextAgentOptions["llm"] = {
  apiKey: process.env.FASTCONTEXT_API_KEY ?? "",
  baseUrl: process.env.FASTCONTEXT_ENDPOINT ?? "",
  model: process.env.FASTCONTEXT_MODEL ?? "",
};
```

This is a direct object construction, not an environment object handed to a child process — there
is no more risk of leaking unrelated `process.env` entries into a subprocess, since
`runFastContextAgent` is a plain function call within the same process.

---

## 15. Non-Goals / Out of Scope

1. **Automatic Code Modification / Patch Application**: This tool is specialized for "codebase
   exploration and identification," and does not have any modification features such as `sed`,
   `patch`, or file writing.
2. **`benchmark/` (SWE-bench, Docker, `bench_fastcontext.py`, `bench_mini_swe_agent.py`)**:
   Unrelated system, unrelated runtime, out of scope for this package entirely.
3. **Conversation Context Persistence**: Each tool call is completely stateless; "interactive
   continuous exploration" that inherits past call history is not supported.
4. **Final-Answer Output Processing / Formatting**: The wrapper does not perform any truncation,
   tag extraction, or formatting on the sub-agent's final answer text. All interpretation is left
   to the main agent (§3.2). (Intermediate tool-call truncation, per §8, is a property of the
   ported tools themselves and is not part of "wrapper processing.")
5. **Changing the `fc_search` tool's public parameter schema** (§2.1) or its
   `description`/`promptGuidelines` in `extensions/index.ts`.
6. **Build/compile step for `extensions/index.ts`**: Do not introduce one beyond what `pi`'s
   `jiti` runtime already handles (per the existing `docs/pi-package.md` invariant that extensions
   run directly, uncompiled).
7. **Streaming responses, retries/backoff beyond what upstream has (none), or additional LLM
   providers**: this is a straight port plus a runtime swap, not a feature expansion.
8. **`fastcontext` Python binary management**: no longer applicable — there is no Python binary in
   this design to manage.

---

## 16. Known Issues & Technical Debt

### KN-001: Halted Exploration on Hallucinated Paths
The model may infer non-existent directory names from file names (e.g., `duet.json` → `duet-js/`) 
and continue accessing them for extended turns despite IO errors.

**Root Cause**: LLM exploration strategy issue (not agent infrastructure)

**Proposed Mitigation**: Track consecutive failures per path and include corrective hints:
```typescript
// After N (>3) consecutive failures on same path:
"[Suggestion] Directory/file not found. Available top-level items: [${topLevel.join(', ')}]. " +
"Please try Glob tool instead."
```

### KN-002: Strategy 2 Duplicate Resolution (Fixed)
Resolved: `/test/sample.js` with cwd `.../test` was incorrectly resolved to `test/test/sample.js` 
instead of `test/sample.js`. Fix: Skip Strategy 2 when first path component matches cwd basename.

### KN-003: FastContext-RL Model Path Persistence and Fabricated Answers
FastContext-RL models show strong persistence to non-existent file paths after exploration failures,
often retrying failed access for up to `maxTurns` iterations and returning fabricated `<final_answer>` 
content about files never actually read. SFT models significantly reduce (but do not eliminate) this
tendency.

**Verification**: Confirmed on production servers with trajectory recording.

**Mitigation**: Set `FASTCONTEXT_MODEL` to an SFT model in environment configuration.

### KN-004: Ripgrep Regular Expression Syntax Errors
Ripgrep occasionally returns regex syntax errors (e.g., `repetition operator missing expression`) 
from patterns generated by the LLM. Currently, raw error messages are returned directly as tool results.

**Example errors**:
- `regex parse error:` with various pattern descriptions
- `repetition operator missing expression`

### KN-005: Model Verification — `InternScience/Agents-A1-4B`

General-purpose tool calling model verified to cover fastcontext functionality without domain-specific training. See README §Model Selection Recommendation for detailed analysis.

| Attribute | Details |
|---|---|
| **Model** | `InternScience/Agents-A1-4B` (Qwen3.5-based, 4B param, tool calling) |
| **Verification Target** | `pi-fa-merge` repository (small-to-medium scale), trajectory records retained |

**Query Results**:

| # | Query Type | Result | Notes |
|---|---|---|---|
| 1 | Specific value identification | ✅ Accurate | Correctly identified default URL and retry count values from actual code files |
| 2 | Exact error message extraction | ✅ Accurate | Returned verbatim error string matching source code exactly |
| 3 | Non-existent file question (`main.rs`) | ✅ Accurate (no hallucination) | Honestly reported non-existence, identified correct project type, summarized actual existing files. FastContext-RL contrast: confidently fabricated answer |

**Model Selection Priority**:

1. **Most Recommended**: General-purpose tool calling small model (Agents-A1-4B or equivalent) — verified superior honesty and accuracy
2. **Second Choice**: FastContext-SFT — self-correction capability; occasional exploration meandering observed
3. **Not Recommended**: FastContext-RL — strong path persistence to non-existent files, fabricated answers

**Important Limitation**: Verification conducted only on small-to-medium scale repositories. Stability on larger, more complex codebases not verified.

**Sampling Notes for Qwen3.5-based Models**:
- `enable_thinking: false` — prevent token waste on CoT blocks
- `presence_penalty: 1.5` — may reduce path repetition in failed explorations
