# Design Specification: `pi-fc-search` Integration Package for `pi` (In-Process TypeScript Version)

This design specification defines the implementation requirements for integrating Microsoft's repository exploration sub-agent tool `fastcontext` as a native in-process TypeScript module within the `pi-fc-search` extension package for the AI agent platform `pi`.

## 1. Purpose and Architecture Overview

### 1.1 Background and Problem

When AI coding agents handle large source code repositories, naively scanning all files or performing imprecise `grep` operations leads to excessive consumption of LLM context tokens, resulting in response degradation and reduced code modification accuracy. Particularly in "cold start states" where the agent doesn't know what exists and where, the problem of agents getting lost in the codebase frequently occurs.

**Windows PATH Resolution Issue**: The previous implementation using `child_process.spawn()` to call a separately installed Python package (`fastcontext`, via `uv tool install`) had significant problems on Windows:
- `ENOENT` failures due to PATH resolution issues
- Slow cold-start (new Python interpreter + imports on every tool call)
- Requirement for working Python 3.12+ and `uv` toolchain in addition to Node.js

### 1.2 Solution

Port the `fastcontext` Python exploration sub-agent into native TypeScript, running **in-process** inside the `pi-fc-search` extension. This eliminates the need for external Python CLI installation while maintaining behavioral parity with the original implementation.

```
Before: pi (Node) --spawn--> fastcontext CLI (Python process)
                        └─ LLM calls (OpenAI-compatible)
                        └─ rg subprocess (Glob/Grep tools)
                        └─ file reads (Read tool)

After:  pi (Node) --function call--> fastcontext-agent (TS module, same process)
                                └─ LLM calls (fetch, OpenAI-compatible)
                                └─ rg subprocess (via bundled ripgrep binary)
                                └─ file reads (Read tool, node:fs)
```

> **💡 Language Stack and Dependencies**
> This package is implemented entirely in **TypeScript (Node.js)** environment. It requires no Python runtime or Docker. The only dependencies are:
> - `@vscode/ripgrep` - Provides prebuilt ripgrep binary for platform-correct file searching

---

## 2. Input Specifications (Inputs & Constraints)

### 2.1 Extension / Tool Input Parameters (JSON Schema)

The input structure when the main agent calls this tool via the `pi` platform:

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
      "default": 15,
      "minimum": 1,
      "maximum": 50
    },
    "use_citation": {
      "type": "boolean",
      "description": "Enable citation mode (output only file paths and line numbers). Default is false for full context with summaries.",
      "default": false
    }
  },
  "required": ["description", "prompt"]
}
```

### 2.2 System Environment Prerequisites and Constraints

1. **Runtime Environment**: The `pi` platform runtime (Node.js + jiti). No Python required.
2. **Working Directory (cwd)**: Commands must be executed in the root directory of the target repository for exploration.
3. **Authentication Environment Variables**: Environment variables required for LLM API calls made internally by fastcontext must be configured. The extension supports multiple configuration methods:
   - Shell environment variables (exported before running pi)
   - `.env` file in the package directory (automatically loaded at module initialization)

   The extension automatically loads `.env` from the following locations (in order of precedence):
   1. Current working directory (`./.env`)
   2. Package directory (`./extensions/../.env`)
   3. Extension directory (`./extensions/.env`)

   **Environment Variable Mapping**:
   - `FASTCONTEXT_API_KEY` → mapped to `API_KEY` for LLM client
   - `FASTCONTEXT_ENDPOINT` → mapped to `BASE_URL` for LLM client  
   - `FASTCONTEXT_MODEL` → mapped to `MODEL` for LLM client

---

## 3. Output Specifications (Outputs & Guarantees)

### 3.1 Output Data Structure

The tool returns the **raw output from fastcontext agent** without any processing, truncation, or formatting:

**Default mode (`use_citation: false`):**
Returns full natural language response with summaries, reasoning, and file contexts.

**Citation mode (`use_citation: true`):**
Returns machine-readable `<final_answer>` block with only file paths and line ranges:
```
<final_answer>
src/auth/middleware.py:20-50
src/api/routes.py:110-140
</final_answer>
```

### 3.2 Output Handling - Pass-Through Design

**No truncation or processing is applied to the output.** The extension passes through:
- All agent output exactly as generated
- `<final_answer>` tags and exploration logs in their original form
- Complete error messages from failures

### 3.3 Guarantees

1. All output file paths must be relative paths from the current directory (`cwd`) at execution time or valid absolute paths.
2. The line ranges (line ranges) presented must be valid line numbers actually existing in the target file.

---

## 4. Invariants

The following conditions must always be maintained throughout the tool's execution lifecycle:

1. **State Isolation**: `fastcontext` execution must not make any changes to the code in the repository, the state of the file system, or the Git history (strictly read-only behavior).
2. **High Consistency**: For the same repository state and same `prompt` input, by setting the underlying LLM's configuration to `temperature=0.0`, the consistency of returned file lists and context should be maximized (minimal differences due to the probabilistic nature of LLMs are permitted).
3. **Non-blocking Concurrency**: Even during execution of this tool, the main agent must not be prevented from executing other read operations concurrently in the same environment.

---

## 5. Exception Handling (Failure Cases)

In the TypeScript wrapper handler layer, capture errors and return them to the `pi` runtime in the following format:

| Occurrence Condition | Expected System Behavior / Returned Error Format |
| --- | --- |
| **Missing Parameters** | Error detected by `pi` runtime validation (JSON Schema). Prompt for re-request to LLM or return `Invalid tool arguments`. |
| **No Matching Code Found** | Normal completion and return empty output from fastcontext. The agent interprets the empty result. |
| **LLM API Error / Process Failure** | Detected when the process returns a non-normal exit code (not 0). Return raw stderr output for agent interpretation: `<raw stderr content>` |
| **Timeout** (Exceeding 120 seconds) | Send `SIGKILL` to child processes via `node:child_process` to force termination, and return:<br><br>`[ERROR] pi-fc-search execution timeout exceeded (120 seconds).` |

---

## 6. Acceptance Tests

### 6.1 Test Case 1: Happy Path (Authentication Processing Exploration)

* **Input** (default mode with full context):
```json
{
  "description": "Find authentication routing",
  "prompt": "Find where the API endpoints are defined and how authentication is handled across the repository."
}
```

* **Expected Output** (raw fastcontext output - varies by model response):
```markdown
Based on my analysis of the repository structure, authentication is processed via a custom middleware that validates JWT tokens. 

Key files:
- `src/auth/middleware.py` (lines 20-50) - Handles JWT validation and role-based access
- `src/api/routes.py` (lines 110-140) - Defines REST endpoints with auth integration
```

* **Pass Condition**: Output contains meaningful context about authentication, includes file paths with line numbers, and matches the format returned by fastcontext CLI. The agent receives **unmodified output** and interprets it directly.

### 6.2 Test Case 2: Exception Path (Command Not Found)

* **Mock Environment**: Intentionally exclude the `fastcontext` binary from the environment variable `PATH`.
* **Input**:
```json
{
  "description": "Trigger failure test",
  "prompt": "Locate anything."
}
```

* **Expected Output**:
```text
[ERROR] fastcontext command not found. Ensure the package is properly initialized.
```

* **Pass Condition**: String contains `[ERROR]` and `command not found`, and the system is safely handled as an error without crashing.

### 6.3 Test Case 3: Pass-Through Verification (No Truncation)

* **Input**: A query expected to produce large output (>50KB)
* **Expected Output**: Complete output without any truncation markers or limits applied
* **Pass Condition**: No `[Output truncated: ...]` messages appear in the output. The agent receives the full result.

---

## 7. Non-goals

1. **Automatic Code Modification / Patch Application**: This tool is specialized for "codebase exploration and identification," and does not have any modification features such as `sed`, `patch`, or file writing.
2. **fastcontext Binary Management**: Providing pre-installation scripts for `fastcontext` and dependent tools (`ripgrep`, etc.) on the execution environment is out of scope.
3. **Conversation Context Persistence**: Each tool call is completely stateless, and "interactive continuous exploration" that inherits past call history is not supported.
4. **Output Processing / Formatting**: The wrapper does not perform any truncation, tag extraction, or formatting on fastcontext output. All interpretation is left to the agent.

---

## 8. TDD Task Breakdown & Implementation Strategy

### 8.1 Task Breakdown (TDD Order)

#### Task 1: Test Stub Creation and Environment Validation Test (TypeScript)

Write test code compliant with `pi` schema without additional dependencies to external test frameworks (using Node.js built-in `node:test` and `node:assert`). Confirm that validation errors for missing parameters and exception handling when CLI is absent function correctly.

#### Task 2: `pi-fc-search` Extension Manifest File Definition

Create `package.json` that declares metadata and tool interfaces recognizable by the `pi` agent platform. Ensure that `dependencies` only contains required packages (`@vscode/ripgrep`).

#### Task 3: Tool Execution Wrapper Handler Implementation (TypeScript)

Implement logic using native ripgrep binary to explore the codebase, process LLM calls directly without spawning external processes. Collect standard output **without truncation or processing**, and return raw data to the agent.

---

## 9. Environment Configuration and .env File Support

The extension supports loading environment variables from a `.env` file for convenient configuration management.

### 9.1 .env File Format

Create a `.env` file with the following variables:

```env
# API key for fastcontext authentication (optional)
FASTCONTEXT_API_KEY=your-api-key-here

# Base URL of the fastcontext endpoint (optional)
FASTCONTEXT_ENDPOINT=https://your-fastcontext-endpoint.com

# Model name to use for fastcontext search (optional)
FASTCONTEXT_MODEL=fastcontext-model-name
```

### 9.2 .env File Loading Implementation

The extension loads `.env` files using only Node.js built-in modules (no external dependencies like `dotenv`):

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

function loadEnvFile(): void {
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
      return;
    }
  }
}

// Load at module initialization
loadEnvFile();
```

### 9.3 Environment Variable Mapping

The extension maps `FASTCONTEXT_*` variables to LLM client parameters:

```typescript
const llmOptions = {
  model: FASTCONTEXT_MODEL || process.env.FASTCONTEXT_MODEL || "",
  apiKey: FASTCONTEXT_API_KEY || process.env.FASTCONTEXT_API_KEY || "",
  baseUrl: FASTCONTEXT_ENDPOINT || process.env.FASTCONTEXT_ENDPOINT || ""
};
```

---

## 10. Process Execution Security Design and Native Implementation Code

Guidelines for completely eliminating shell injection vulnerabilities and implementing safely without external modules.

* **Prohibition of Shell Execution**: **Strictly prohibit** the use of `child_process.exec` and specifying `shell: true` option in `spawn` when generating child processes in Node.js.
* **Argument Array Passing**: Pass prompts containing user input directly to the OS in array format without going through the shell.
* **Standard Validation**: Ensure input safety using only JavaScript standard type checks and string operations such as `typeof`, `typeof prompt === 'string'`, and regular expressions.

**Native Implementation Code Example (TypeScript):**

```typescript
import { spawn } from 'node:child_process';

/**
 * Simple validation example to comply with harness input/output specifications
 * using only built-in features without external libraries like zod
 */
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

// Example of execution handler internals - Pass-through design
export async function handleSearch(rawArgs: any): Promise<string> {
  const { prompt } = validateInput(rawArgs);

  return new Promise((resolve, reject) => {
    // Explicitly set shell: false to defend against shell injection
    const child = spawn('fastcontext', ['-q', prompt, '--citation'], {
      cwd: process.cwd(),
      env: process.env,  // Pass through all environment variables
      shell: false 
    });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
    });

    child.on('close', (code) => {
      if (code !== 0) {
        if (stderrData.includes('not found')) {
          return resolve('[ERROR] fastcontext command not found. Ensure the package is properly initialized.');
        }
        // Return raw stderr for agent interpretation
        return resolve(stderrData || '[ERROR] Subagent execution failed.');
      }
      
      // Pass through stdout without any processing or truncation
      resolve(stdoutData); 
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}
```
---

## A. Native TypeScript Sub-Agent Specification (Port Details)

This section provides detailed specifications for porting the fastcontext Python implementation to TypeScript.

### A.1 Background & Problem

The current `extensions/index.ts` implementation calls out to a separately installed Python
package (`fastcontext`, via `uv tool install`) as a child process:

```ts
spawn("fastcontext", args, { cwd, env: childEnv, shell: false });
```

This requires a working Python 3.12+ + `uv` toolchain to be present and on `PATH` on every
machine that runs `pi`, in addition to Node.js. On Windows in particular this is a common source
of `ENOENT` failures, PATH resolution issues, and slow cold-start (new Python interpreter +
imports on every tool call). The original tool has **no Docker dependency** — Docker is only used
by an unrelated SWE-bench benchmark harness in the same upstream repo and is out of scope here.

### A.2 Goal / Non-Goals

**Goal:** Replace the spawned Python process with a TypeScript module living inside the
`pi-fc-search` package, callable as a plain async function from `extensions/index.ts`. Result:
`pi-fc-search` depends only on Node.js + npm packages. No Python, no Docker, no PATH-based binary
discovery for `fastcontext` itself.

**Non-Goals:**
- Do not touch or port `benchmark/` (SWE-bench harness, Docker orchestration). Out of scope.
- Do not change the external contract of the `fc_search` tool as seen by `pi` (name, parameter
  schema, return shape) — this is an internal implementation swap, not a tool redesign.
- Do not add streaming output support unless already present upstream (it is not).

### A.3 Directory / File Layout

Add a new subdirectory inside the existing `pi-fc-search` package:

```
.
├── extensions/
│   └── index.ts                  # modified: no more spawn(); calls runFastContextAgent()
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
├── package.json                  # add dependencies (see §9)
└── skills/pi-fc-search/SKILL.md  # unchanged (external contract does not change)
```

### A.4 Invariants

1. **Single-process invariant**: No `child_process.spawn` of a Python interpreter or the
   `fastcontext` CLI anywhere in the final implementation.
2. **Ripgrep-bundling invariant**: The `rg` binary used by Glob/Grep must come from a bundled,
   platform-resolved dependency (see §9), never from an assumption that `rg` is on the user's
   system `PATH`. System `PATH` may be used only as a fallback, never as the primary path.
3. **Behavioral parity invariant**: Tool JSON schemas, truncation limits, permission checks, and
   system prompt content must match the original Python implementation exactly, per §7–§8, unless
   explicitly marked as changed in this document.
4. **External contract invariant**: The `fc_search` tool's name, `parameters` JSON schema, and
   `content`/`isError` return shape registered via `pi.registerTool(...)` in `extensions/index.ts`
   must not change. Only the internal execution path changes.
5. **No native Jinja2 dependency**: The system prompt uses only `${VAR}` substitution (see
   `system.md` in §8.4) — implement with a trivial string-replace, not a templating library.
6. **Working-directory containment invariant**: Read/Glob/Grep must refuse to operate outside the
   `cwd` passed in by the caller, using path comparison that is correct on Windows (drive letters,
   case-insensitivity, backslash vs forward-slash) — see §10.
7. **Cancellation invariant**: The agent must respect the `AbortSignal` passed in from
   `pi.registerTool(...).execute(...)`, cancelling in-flight LLM `fetch` calls and stopping before
   the next turn. Because there is no longer a child process to `SIGKILL`, cancellation must be
   cooperative (checked between turns and threaded into `fetch`'s `signal` option).

### A.5 Public API (replaces `executeFastcontext` in `extensions/index.ts`)

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

`extensions/index.ts` calls this directly instead of `executeFastcontext(...)`. Remove the
`TIMEOUT_SECONDS`/`spawn`/stdout-stderr collection logic; the 120s timeout should be re-implemented
as a `Promise.race` / `setTimeout` around the direct function call, still resolving (not
rejecting) with the original `"[ERROR] ... timeout exceeded (120 seconds)."` message shape used
today, so `pi`'s tool-result formatting does not need to change.

### A.6 Tool Ports — Exact Behavioral Specs

#### A.6.1 Read tool (port of `read.py`)

- **name**: `Read`
- **parameters**: `{ path: string (required), offset?: integer, limit?: integer }`
- **description**: verbatim content of `read.md` (§8.3), loaded at module init, not re-authored.
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

#### A.6.2 Glob tool (port of `glob.py`)

- **name**: `Glob`
- **parameters**: `{ directory?: string, pattern: string (required) }` — `directory` defaults to
  the tool-call's `cwd`.
- **description**: verbatim content of `glob.md` (§8.1).
- **Behavior**:
  - Reject if `directory` is not an existing directory.
  - Reject with `` `Permission error: \`${directory}\` is not within the working directory \`${cwd}\`.` ``
    if `directory` resolves outside `cwd` (see §10 for correct Windows path containment logic).
  - Run: `rg --files ${directory} --glob ${pattern}` with `cwd` as the subprocess cwd, 10s timeout.
  - On timeout: `` `Tool \`Glob\` timed out after 10s.` ``
  - On non-zero exit: return stderr text.
  - Split stdout into lines; cap to **first 100 matches**, appending
    `` `Results are truncated: showing first 100 results. Consider using a more specific path or pattern.` ``
    if truncated.
  - If zero matches → `"No files found"`.

#### A.6.3 Grep tool (port of `grep.py`)

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
- **description**: verbatim content of `grep.md` (§8.2).
- **Defaults**: `path` defaults to `cwd`; `-C` (context) defaults to `3`; `-n` (line numbers)
  defaults to `true`; `output_mode` has no hardcoded default in the schema but downstream
  ripgrep-arg-building only adds `--files-with-matches`/`--count-matches`/content-flags based on
  the value provided — port the `run_rg` arg-building logic 1:1 including the
  `output_mode === "count_matches"` string (note: this is inconsistent with the schema enum value
  `"count"` in the original Python — preserve this exact inconsistency rather than "fixing" it,
  since fixing it is a behavior change out of scope for this port; flag it in code comments as a
  known upstream quirk).
  - Reject if `path` resolves outside `cwd` (same containment check as Glob, §10).
  - Always append `--heading --color never` to the `rg` invocation.
  - Cap output to **100 lines** by default; if `head_limit` is provided and
    `0 < head_limit < 100`, use `head_limit` instead. Append
    `` `Results truncated to first ${limit} lines` `` when truncated.
  - Empty output → `"No matches found"`.

#### A.6.4 ToolSet (port of `tool.py`)

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

### A.7 System Prompt & Tool Descriptions

Port these four files **verbatim** (content is provided here so the implementing agent does not
need to re-derive it):

#### A.7.1 `glob.md`
```
- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.
```

#### A.7.2 `grep.md`
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

#### A.7.3 `read.md`
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
(As noted in §7.1, the *code* truncates lines at 2000 chars, not 500 — port code behavior, keep
this docstring text unchanged since it is model-facing prose, not a spec for your implementation.)

#### A.7.4 `system.md` (Jinja2 `${VAR}` syntax → plain string substitution)
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

### A.8 Dependencies (`package.json`)

Add to the existing zero-npm-dependency `pi-fc-search` package (README currently advertises "Zero
dependencies"; update that claim once these are added):

- **`@vscode/ripgrep`** — provides a `rgPath` export resolving to a platform-correct `rg`/`rg.exe`
  binary.

  Package characteristics (important for implementation agents): the npm tarball includes per-
  platform binaries directly; there is no postinstall network download and no runtime network access
  is required. `optionalDependencies` point at `@vscode/ripgrep-<os>-<cpu>` packages that are
  resolved at install time.

  ```ts
  import { rgPath } from "@vscode/ripgrep";
  // child_process.spawn(rgPath, [...])
  ```

  Use `rgPath` as the primary binary path for Glob/Grep; fall back to system `PATH`-resolved `rg`
  only if the bundled binary is somehow unavailable, and log a warning in that fallback case.

- No LLM SDK is strictly required — plain `fetch` against the OpenAI-compatible
  `POST {baseUrl}/chat/completions` endpoint is sufficient and keeps the dependency footprint
  minimal, consistent with the existing package's stated philosophy. If the implementing agent
  prefers the `openai` npm package for correctness around edge cases (tool-call streaming
  deltas, etc.), that is acceptable but must be justified in a code comment.

  **Tool-call id synthesis**: some servers (mlx-lm and others) return tool calls with `id: null`. The
  implementation must synthesize ids when omitted — the original repo includes an upstream fix for
  this (synthesized as `call_{uuid}` format). Without this, the agent crashes on its first tool call.

### A.9 Windows-Correct Path Containment (replaces Python's `Path.is_relative_to`)

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

### A.10 TDD Task Breakdown

Implement and verify in this order; do not reorder.

#### Requirement A: Tool parity
**Acceptance Test:** For a fixture directory, `Read`/`Glob`/`Grep` TS implementations produce
byte-identical output to the Python originals for: (1) a normal file read, (2) an out-of-range
`offset`, (3) a glob with >100 matches (verify truncation message), (4) a grep with
`output_mode: "content"` and `-C 3`, (5) a path-containment violation for all three tools.
**Implementation Strategy:** Port §7.1–§7.4 exactly; write fixtures under a `__fixtures__/` dir
committed to the package for repeatable testing.

#### Requirement B: Agent loop parity
**Acceptance Test:** Given a mocked LLM client that returns a scripted sequence of tool calls then
a final answer, the agent loop (a) writes one JSONL line per message to the trajectory file, (b)
stops at `max_turns` with the exact original message
`` `No final answer after ${max_turns} turns.` `` when no final answer is reached, (c) with
`citation: true`, returns only the `<final_answer>...</final_answer>` block via a regex extraction
identical to `get_final_answer` in `utils.py`.
**Implementation Strategy:** Port `agent.ts`/`context.ts` from `agent.py`/`context.py` 1:1,
including the turn-counting off-by-one behavior (`n_turn > max_turns + 1` and the
`n_turn == max_turns + 1` "please provide final answer" injection).

#### Requirement C: In-process integration
**Acceptance Test:** `extensions/index.ts`'s `fc_search` tool, when invoked, no longer spawns any
child process for `fastcontext` itself (verify via a test that stubs/spies on `child_process.spawn`
and asserts it is not called for this purpose), and returns output structurally equivalent to
today's `executeFastcontext` return value for the same inputs.
**Implementation Strategy:** Replace the `executeFastcontext` function body with a call to
`runFastContextAgent(...)` (§6); keep `validateInput`, the tool schema, `onUpdate` progress
reporting, and the `pi.registerTool(...)` registration unchanged.

#### Requirement D: Cross-platform verification (Windows / macOS / Linux)
**Acceptance Test:** Run the full `fc_search` tool end-to-end on all three target OSes with no
Python installed and no `rg` on `PATH`, against a repo containing paths with spaces:
  - **Windows:** working directory under a drive letter other than `C:`. Must succeed.
  - **macOS:** working directory under a path containing non-ASCII characters (common on
    localized user home directories); verify the bundled `rg` binary is not blocked by Gatekeeper
    on first run (see Failure Cases §12 for the quarantine-attribute case).
  - **Linux:** run on both `x64` and `arm64` runners if available.
  In all three cases, result output must be structurally identical (same truncation limits, same
  message text) for equivalent fixture inputs — no OS-specific branches in the tool/agent code
  should be needed to achieve this.
**Implementation Strategy:** CI matrix job across `windows-latest`, `macos-latest`, and
`ubuntu-latest` (plus an `arm64` Linux runner if available in CI), each with `PATH` scrubbed of
any Python install, running the Requirement A–C test suites unmodified on each OS. A single test
suite running unchanged on all three legs is itself part of the acceptance bar — if a leg needs
OS-conditional test code, treat that as a signal the implementation leaked an OS-specific
assumption and fix the implementation, not the test.

### A.11 Failure Cases

- **Condition:** `@vscode/ripgrep`'s bundled binary is missing for the current platform/arch (e.g.
  unsupported CPU architecture).
  **Expected Behavior:** Fall back to system `PATH` resolution of `rg`; if that also fails, Glob/
  Grep tool calls return a `failed: true` `ToolResult` with a clear message — never throw
  uncaught, never crash the whole `pi` extension host.

- **Condition:** LLM endpoint (`baseUrl`) is unreachable or times out.
  **Expected Behavior:** Same shape as `RequestyAPIError` in the original — the agent loop
  captures this, appends an assistant message describing the failure, and returns that message as
  the final output, rather than throwing out of `runFastContextAgent`.

- **Condition:** On macOS, the bundled `rg` binary carries a `com.apple.quarantine` extended
  attribute (can happen if the binary reaches the machine via a path other than a normal
  `npm install`, e.g. a manually copied `node_modules` or a zipped package transferred outside
  npm) and Gatekeeper blocks first execution.
  **Expected Behavior:** The Glob/Grep tool call fails with a clear, actionable message
  (surface the OS error text rather than swallowing it) rather than hanging or producing an
  opaque `ENOENT`/`EACCES`. Document in the package README that this is resolved by a normal
  `npm install` (which does not set the quarantine attribute) and, if it ever occurs, by running
  `xattr -d com.apple.quarantine <path-to-rg>` on the affected binary.

- **Condition:** `AbortSignal` fires mid-turn (user/pi cancels the tool call).
  **Expected Behavior:** In-flight `fetch` is aborted, the agent loop stops before starting a new
  turn, and `runFastContextAgent` rejects/resolves consistently with how `extensions/index.ts`
  currently handles cancellation (today: `reject(new Error("Operation was cancelled"))`, caught in
  `execute()` and converted to a non-error `content` response — preserve this exact UX).

### A.12 Out of Scope (explicitly do not do this)

- Do not port or touch `benchmark/` (SWE-bench, Docker, `bench_fastcontext.py`,
  `bench_mini_swe_agent.py`). Unrelated system, unrelated runtime.
- Do not change the `fc_search` tool's public parameter schema (`SearchToolSchema` in
  `extensions/index.ts`) or its `description`/`promptGuidelines`.
- Do not introduce a build/compile step for `extensions/index.ts` beyond what `pi`'s `jiti`
  runtime already handles (per the existing `docs/pi-package.md` invariant that extensions run
  directly, uncompiled).
- Do not add streaming responses, retries/backoff beyond what upstream has (none), or additional
  LLM providers — this is a straight port plus a runtime swap, not a feature expansion.
