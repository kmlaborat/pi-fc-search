---
name: pi-fc-search
description: Repository search tool using Microsoft's fastcontext. Use when you need to find code patterns, understand architecture, or locate specific functionality in large codebases. This tool is more efficient than scanning entire files or using basic grep, especially for cold-start situations where you don't know what exists in the codebase.
---

# pi-fc-search Skill

## Overview

This skill provides repository search capabilities through Microsoft's fastcontext tool. It allows efficient codebase exploration without consuming excessive context tokens.

## When to Use

Use this skill when:
- Starting work on an unfamiliar codebase (cold start)
- Need to find where specific functionality is implemented
- Understanding code architecture and patterns
- Locating files related to authentication, API endpoints, error handling, etc.
- Searching for code patterns across large repositories

## Setup

### Environment Variables

Configure the fastcontext API credentials using one of these methods:

**Method 1: .env file (recommended)**

Create a `.env` file in one of the following locations (loaded automatically at module initialization):

```env
# API key for fastcontext authentication
FASTCONTEXT_API_KEY=your-api-key-here

# Base URL of the fastcontext endpoint
FASTCONTEXT_ENDPOINT=https://your-fastcontext-endpoint.com

# Model name to use for fastcontext search (see README §Model Selection)
FASTCONTEXT_MODEL=InternScience/Agents-A1-4B
```

For model selection details and sampling parameters, see README **§Model Selection Recommendation**.

**Method 2: Shell environment variables**

```bash
export FASTCONTEXT_API_KEY=your-api-key-here
export FASTCONTEXT_ENDPOINT=https://your-fastcontext-endpoint.com
export FASTCONTEXT_MODEL=InternScience/Agents-A1-4B
```

The skill automatically loads `.env` files from the following locations (in order):
1. Current working directory (`process.cwd()/.env`)
2. Package directory (resolved from `import.meta.url`, typically project root level)
3. Node modules shared environment (`node_modules/.env`)

**Features:**
- Only built-in Node.js modules used (no external dependencies like `dotenv`)
- Supports `KEY=VALUE` format with optional quotes (`"value"` or `'value'`)
- Lines starting with `#` are treated as comments
- Failed file reads are silently ignored (does not break execution)

No additional setup required otherwise. The skill is automatically loaded with the pi-fc-search package.

## Usage

Call the `fc_search` tool with the following parameters:

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `description` | string | Short task description (3-5 words) |
| `prompt` | string | Detailed natural language instruction or question |
| `max_turns` | integer | Maximum search turns. Default is 15 for thorough exploration. Range: 1-50. |
| `use_citation` | boolean | Enable citation mode (output only file paths and line numbers). Default is false for full context with summaries. |

### Example

```json
{
  "description": "Find authentication routing",
  "prompt": "Find where the API endpoints are defined and how authentication is handled across the repository."
}
```

### Response Format

The tool returns the **raw output from fastcontext CLI without any processing or truncation**. The format depends on the `use_citation` parameter:

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
Returns machine-readable `<final_answer>` block with only file paths and line ranges:
```
<final_answer>
src/auth/middleware.py:20-50
src/api/routes.py:110-140
</final_answer>
```

> **Note:** The output is passed through without any truncation or processing. All search logs, reasoning steps, and `<final_answer>` tags are returned in their original form for the agent to interpret directly.

Use citation mode when you need compact, parseable output for programmatic processing. Default mode provides richer context for understanding the codebase.

## Best Practices

1. **Be specific in prompts**: Use clear, detailed questions to get better results
2. **Start broad, then narrow**: Begin with general queries, then refine based on results
3. **Use descriptions effectively**: Keep descriptions short but informative for tracking
4. **Check for errors**: Handle cases where fastcontext is not installed or returns errors
5. **Review full output**: Since output is not truncated, review all search logs and reasoning for complete context

## Limitations

- Requires @vscode/ripgrep package (bundled with pi-fc-search)
- Maximum prompt length: 2000 characters
- Maximum description length: 100 characters
- Execution timeout: 120 seconds
- No output truncation - large responses are returned completely
- No external dependencies beyond @vscode/ripgrep (uses only Node.js built-in modules)
