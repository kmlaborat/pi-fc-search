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
- **Error handling**: Comprehensive error reporting and recovery
- **Zero external dependencies**: Uses only `@vscode/ripgrep` (all other logic uses Node.js built-ins)

## Installation

### From local directory

```bash
pi install ./path/to/pi-fc-search
```

### From git repository

```bash
pi install git:github.com/user/pi-fc-search
```

## Prerequisites

### 1. Ripgrep Dependency

The ported implementation requires one npm dependency:
- `@vscode/ripgrep` - Provides prebuilt ripgrep binary for file searching (bundled, no system PATH required)

### 1. Environment Configuration

You can configure environment variables in two ways:

#### Option A: Using .env file (recommended)

Create a `.env` file in your project directory or package directory. You can start from the provided `.env.example` template:

```bash
cp .env.example .env
# Edit .env with your configuration
```

Example `.env` file:
```
FASTCONTEXT_API_KEY="your-api-key"
FASTCONTEXT_ENDPOINT="https://your-fastcontext-endpoint.com"
FASTCONTEXT_MODEL="FastContext-RL"
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

The extension automatically loads the `.env` file from the following locations (in order):
1. Current working directory (`./.env`)
2. Package directory (`./extensions/../.env`)
3. Extension directory (`./extensions/.env`)

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

## Acknowledgements

This package ports the following upstream repository:
- [manjunathshiva/fastcontext](https://github.com/manjunathshiva/fastcontext)
  - Preserved mirror of Microsoft's removed FastContext repo (arXiv:2606.14066)
  - With fixes for local serving on macOS via mlx-lm

## License

MIT
