# pi-fc-search

Pi coding agent extension package for fastcontext repository search.

## Overview

This package integrates fastcontext-style repository search with the pi coding agent, enabling efficient codebase exploration without consuming excessive context tokens. The implementation is written in TypeScript for in-process execution (no external Python process required).

**Design target (v3):** any **general small agentic model** served over an OpenAI-compatible `/chat/completions` endpoint with tool calling — including CPU-served local models. The sub-agent is deliberately read-only (Read/Glob/Grep scoped to the working directory) and model-agnostic; see [docs/SPEC.md §19](docs/SPEC.md#19-v3-general-model-redesign).

### Origin

- **Inspired by / originally ported from**: [manjunathshiva/fastcontext](https://github.com/manjunathshiva/fastcontext), a preserved mirror of Microsoft's removed FastContext repo (arXiv:2606.14066)
- v1/v2 maintained behavioral parity with that Python implementation because the design target was Microsoft's FastContext model. That model was removed from all official repositories and is **no longer the design target** (SPEC §19): prompts, tool descriptions, and sampling defaults were redesigned for general small agentic models, while the tool set, path containment, agent loop, and defensive layers (including Docker-mount path normalization) were retained
- The package still works with community-mirrored MS FastContext models if you prefer them, but no code path assumes them

## Features

- **Natural language search**: Query your codebase with plain English questions
- **Citation mode**: Returns machine-readable `<final_answer>` block with file paths and line ranges (fastcontext `--citation` flag)
- **Context-efficient**: Returns only relevant file locations and summaries
- **Pass-through output**: Final answers returned without wrapper-level truncation
- **No repo pollution**: debug trajectories are written to the OS temp directory, never into the searched repository
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

Example `.env` file:
```
FASTCONTEXT_API_KEY="your-api-key"
FASTCONTEXT_ENDPOINT="https://your-fastcontext-endpoint.com"
FASTCONTEXT_MODEL="InternScience/Agents-A1-4B"
```

#### Option B: Using shell environment variables

```bash
export FASTCONTEXT_API_KEY="your-api-key"
export FASTCONTEXT_ENDPOINT="https://your-fastcontext-endpoint.com"
export FASTCONTEXT_MODEL="FastContext-RL"
```

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

Tool response (citation mode):
### Relevant Files

- **src/auth/middleware.py**: lines [20-50]
- **src/api/routes.py**: lines [110-140]

The underlying fastcontext `--citation` flag returns a machine-readable `<final_answer>` block:
```
<final_answer>
src/auth/middleware.py:20-50
src/api/routes.py:110-140
</final_answer>
```
```

## Configuration

### Environment Variables

The extension reads the following environment variables from the `.env` file or shell environment (shell variables win over `.env`, SPEC §15/D-011):

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `FASTCONTEXT_API_KEY` | API key for LLM calls | No | *(empty — fine for local servers that ignore auth)* |
| `FASTCONTEXT_ENDPOINT` | Base URL of any OpenAI-compatible endpoint (`POST /chat/completions` with tool calling) | **Yes** | — |
| `FASTCONTEXT_MODEL` | Model name to use | **Yes** | — |
| `FASTCONTEXT_TEMPERATURE` | Sampling temperature (0–2) | No | `0.2` |
| `FASTCONTEXT_MAX_TOKENS` | Max completion tokens per LLM call | No | `32000` |
| `FASTCONTEXT_TIMEOUT_SECONDS` | Total execution timeout (integer ≥ 5). Raise for CPU-served local models | No | `120` |

`FASTCONTEXT_ENDPOINT` and `FASTCONTEXT_MODEL` must be set; the tool fails fast with an actionable error if either is missing (SPEC §18/D-005). Invalid numeric values for the sampling/timeout variables warn and fall back to the defaults.

### Model Selection

Any general small agentic model with reliable tool calling works. Pick the smallest one your hardware can serve comfortably — the sub-agent loop (up to `max_turns` LLM calls) multiplies per-call latency.

| Profile | Model | Serving | Notes |
|---------|-------|---------|-------|
| **Recommended (verified)** | `InternScience/Agents-A1-4B` | mlx-lm / vLLM / llama.cpp | Verified across query types: honest exploration (does not fabricate results for non-existent files), accurate answers, good parallel tool calling (SPEC KN-005) |
| **CPU-friendly** | `LiquidAI/LFM2.5-2.6B` | llama.cpp / vLLM | Small enough for CPU inference. **Set `FASTCONTEXT_TIMEOUT_SECONDS=600`** (or higher) — CPU latency makes the 120s default unreachable. Keep `FASTCONTEXT_TEMPERATURE` low (default 0.2) |
| **General** | any OpenAI-compatible tool-calling model | any server | If the model wanders or retries failed paths, lower `max_turns` in the `fc_search` call; see KN-001 |

Example recommended configuration:
```
FASTCONTEXT_MODEL="InternScience/Agents-A1-4B"
```

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
- Failed file reads are silently ignored (does not break execution)

### Error Handling

The extension handles the following error cases:

| Error Type | Description | Recovery |
|------------|-------------|----------|
| Missing Parameters | Invalid tool arguments | Provide valid description and prompt |
| No Matching Code Found | Search returned no results | Refine search query |
| LLM API Error | Upstream API failure | Check API configuration |
| Ripgrep binary missing | Bundled binary unavailable | Ensure @vscode/ripgrep is installed |
| Timeout | Operation exceeds `FASTCONTEXT_TIMEOUT_SECONDS` (default 120s) | Raise the timeout for slow/CPU models, simplify query, or retry |
| User Cancellation | Tool call cancelled during execution | Retry if needed |

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
│   └── tools/, utils/    # Unit test suites
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

# Run linting
npm run lint
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
- **SPEC Version**: Compliant with docs/SPEC.md incl. §17 known issues, §18 documented deviations (D-001 to D-011), and §19 v3 general-model redesign

> **Verification**: Full test suite: `npm test` and `npm run typecheck`. The v3 redesign surfaces (prompt, descriptions, sampling/timeout configuration) are covered by `tests/integration/prompt.test.ts` and `tests/integration/config.test.ts`.

## Known Issues & TODO

### Known Issues

1. **Halted path exploration**: The model may hallucinate non-existent directory names from file names (e.g., `duet.json` → `duet-js/`) and repeat failed accesses for 10+ turns. 
   - **Mitigated in v3 (prompt-level)**: the v3 system prompt (SPEC §19 C-3) explicitly instructs models to verify a file exists (Glob/Grep) before Read — verified effective with `Agents-A1-4B`.
   - **Proposed programmatic mitigation (still TODO)**: add a hint with the top-level directory listing after N consecutive failures on the same path.

### TODO

- [ ] Implement path failure tracking and corrective hints in tool responses (see Known Issues #1)
- [ ] Add integration test infrastructure for fc_search tool execution

## Acknowledgements

This package was originally ported from, and remains inspired by:
- [manjunathshiva/fastcontext](https://github.com/manjunathshiva/fastcontext)
  - Preserved mirror of Microsoft's removed FastContext repo (arXiv:2606.14066)
  - With fixes for local serving on macOS via mlx-lm
- The v3 redesign (SPEC §19) targets general small agentic models; the MS model is no longer a design dependency

## License

MIT
