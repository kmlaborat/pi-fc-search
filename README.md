# pi-fc-search

Pi coding agent extension package for fastcontext repository search.

## Overview

This package integrates Microsoft's fastcontext tool with the pi coding agent, enabling efficient codebase exploration without consuming excessive context tokens.

## Features

- **Natural language search**: Query your codebase with plain English questions
- **Context-efficient**: Returns only relevant file locations and summaries
- **Smart truncation**: Automatically handles large outputs
- **Error handling**: Comprehensive error reporting and recovery
- **Zero dependencies**: Uses only Node.js built-in modules

## Installation

### Via pi CLI

```bash
pi install npm:pi-fc-search
```

### From local directory

```bash
pi install ./path/to/pi-fc-search
```

### From git repository

```bash
pi install git:github.com/user/pi-fc-search@v1.0.0
```

## Prerequisites

### 1. fastcontext CLI Installation

[fastcontext](https://github.com/microsoft/fastcontext) must be installed and available in your PATH:

```bash
# Install fastcontext CLI (follow official documentation)
curl -fsSL https://raw.githubusercontent.com/microsoft/fastcontext/main/install.sh | sh

# Verify installation
fastcontext --version
```

### 2. Environment Configuration

Set the required environment variables:

```bash
export FASTCONTEXT_API_KEY="your-api-key"
export FASTCONTEXT_MODEL="llama-cpp/Qwen3.5-122B-A10B-MTP"
```

### 3. No External Dependencies

This extension follows the **Zero-Dependency** principle:
- Uses only Node.js built-in modules
- No npm dependencies required
- Type validation uses JSON Schema format (not typebox)

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

Tool response:
### Summary
Authentication is processed via a custom middleware that validates JWT tokens. API routes are structurally split.

### Relevant Locations
- **src/auth/middleware.py**: lines 20-50
- **src/api/routes.py**: lines 110-140
```

## Configuration

### Environment Variables

The extension uses the same environment variables as fastcontext:

| Variable | Description | Required |
|----------|-------------|----------|
| `FASTCONTEXT_API_KEY` | API key for LLM calls | Yes |
| `FASTCONTEXT_MODEL` | LLM model to use | Yes |

### Error Handling

The extension handles the following error cases:

| Error Type | Description | Recovery |
|------------|-------------|----------|
| CLI Not Found | fastcontext not installed or not in PATH | Install fastcontext CLI |
| Missing Parameters | Invalid tool arguments | Provide valid description and prompt |
| No Matching Code Found | Search returned no results | Refine search query |
| LLM API Error | Upstream API failure | Check API configuration |
| Timeout | Operation exceeds 120 seconds | Simplify query or retry |

## Package Structure

```
pi-fc-search/
├── package.json          # Package manifest
├── README.md             # This file
├── extensions/
│   └── index.ts          # Extension entry point
└── skills/
    └── pi-fc-search/
        └── SKILL.md      # Skill definition
```

## Development

### Building

No build step required. The package uses TypeScript directly with jiti.

### Testing

```bash
# Run tests with node:test
node --test __tests__/extensions/index.test.ts

# Run the extension in development mode
pi -e ./extensions/index.ts
```

### Compliance

This extension complies with the following SPEC requirements:

- **Zero-Dependency**: No external npm packages (typebox removed, JSON Schema used)
- **Output Format**: SPEC-compliant Markdown format (Section 3.1)
- **Error Handling**: All 5 error types implemented (Section 5)
- **Timeout**: 120 second timeout configured
- **Tests**: Comprehensive test suite with node:test and node:assert

## License

MIT
