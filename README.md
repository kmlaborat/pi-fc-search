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

- [fastcontext](https://github.com/microsoft/fastcontext) CLI installed and available in PATH
- LLM API keys configured (FASTCONTEXT_API_KEY, FASTCONTEXT_MODEL, etc.)

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

No additional configuration required. The extension uses the same environment variables as fastcontext:

| Variable | Description |
|----------|-------------|
| FASTCONTEXT_API_KEY | API key for LLM calls |
| FASTCONTEXT_MODEL | LLM model to use |

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
# Run the extension in development mode
pi -e ./extensions/index.ts
```

## License

MIT
