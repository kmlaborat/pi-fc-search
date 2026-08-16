# pi-fc-search

Pi coding agent extension package for fastcontext repository search.

## Overview

This package integrates Microsoft's fastcontext tool with the pi coding agent, enabling efficient codebase exploration without consuming excessive context tokens. The implementation is ported from the Python version to TypeScript for in-process execution (no external Python process required).

### Ported From

- **Original Repository**: [manjunathshiva/fastcontext](https://github.com/manjunathshiva/fastcontext)
- This is a preserved mirror of Microsoft's removed FastContext repo with fixes for local serving on macOS via mlx-lm
- The TypeScript implementation maintains behavioral parity with the original Python version while running directly within the pi agent environment

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

### 1. Ripgrep Dependency

The ported implementation requires one npm dependency:
- `@vscode/ripgrep` - Provides prebuilt ripgrep binary for file searching (bundled, no system PATH required)

> **Note**: No Python, `uv`, or Docker dependencies are required. The implementation runs entirely in TypeScript within the pi agent process.

### 2. Environment Configuration

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

### 3. Dependencies

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

The extension reads the following environment variables from `.env` file or shell environment:

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `FASTCONTEXT_API_KEY` | API key for LLM calls | No* | (uses fastcontext default) |
| `FASTCONTEXT_ENDPOINT` | Base URL of the fastcontext endpoint | No | (uses fastcontext default) |
| `FASTCONTEXT_MODEL` | LLM model to use | No* | (uses fastcontext default) |

*Optional when using fastcontext defaults. Set these variables to override the default configuration.

### Model Selection Recommendation

Based on comparative verification across multiple query types, the following priority order is recommended:

1. **Most Recommended**: `InternScience/Agents-A1-4B` (or equivalent general-purpose small model with tool calling support). Not a FastContext-dedicated model, but verified to outperform in honesty of exploration (does not fabricate results for non-existent files) and accuracy across all tested queries.
2. **Second Choice**: FastContext-SFT models (e.g., `FastContext-1.0-4B-SFT`). Can self-correct their exploration strategy and return accurate answers based on actually read file contents, though occasional exploration meandering may occur.
3. **Not Recommended**: FastContext-RL models show strong tendency to persistently retry non-existent paths up to `maxTurns` iterations, often returning fabricated `<final_answer>` content about files that were never actually accessed.

Example recommended configuration:
```
FASTCONTEXT_MODEL="InternScience/Agents-A1-4B"
```

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
| Timeout | Operation exceeds 120 seconds | Simplify query or retry |
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
- **Timeout**: 120 second timeout with AbortSignal coordination
- **Cancellation**: Cooperative cancellation via AbortSignal (SPEC §4.10)
- **Tests**: Comprehensive test suite with vitest
- **SPEC Version**: Compliant with docs/SPEC.md (Revision: Native TypeScript Sub-Agent, incl. section 17 documented deviations)

> **Verification**: Implementation audited against SPEC sections 1-16. All mandated message texts, limits, and schemas match; the five intentional hardening deviations are recorded in SPEC section 17 (D-001 to D-005). Full test suite: `npm test` (94 passed, 2 skipped) and `npm run typecheck`.

## Known Issues & TODO

### Known Issues

1. **Halted path exploration**: The model may hallucinate non-existent directory names from file names (e.g., `duet.json` → `duet-js/`) and repeat failed accesses for 10+ turns. 
   - **Proposed mitigation**: Add hint with top-level directory listing after N consecutive failures on same path.

### TODO

- [ ] Implement path failure tracking and corrective hints in tool responses (see Known Issues #1)
- [ ] Add integration test infrastructure for fc_search tool execution

## Acknowledgements

This package ports the following upstream repository:
- [manjunathshiva/fastcontext](https://github.com/manjunathshiva/fastcontext)
  - Preserved mirror of Microsoft's removed FastContext repo (arXiv:2606.14066)
  - With fixes for local serving on macOS via mlx-lm

## License

MIT
