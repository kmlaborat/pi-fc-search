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

No additional setup required. The skill is automatically loaded with the pi-fc-search package.

## Usage

Call the `fc_search` tool with the following parameters:

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `description` | string | Short task description (3-5 words) |
| `prompt` | string | Detailed natural language instruction or question |

### Example

```json
{
  "description": "Find authentication routing",
  "prompt": "Find where the API endpoints are defined and how authentication is handled across the repository."
}
```

### Response Format

The tool returns Markdown-formatted results:

```markdown
### Summary
[Summary of search results]

### Relevant Locations
- **src/auth/middleware.py**: lines 20-50
- **src/api/routes.py**: lines 110-140
```

## Best Practices

1. **Be specific in prompts**: Use clear, detailed questions to get better results
2. **Start broad, then narrow**: Begin with general queries, then refine based on results
3. **Use descriptions effectively**: Keep descriptions short but informative for tracking
4. **Check for errors**: Handle cases where fastcontext is not installed or returns errors

## Limitations

- Requires fastcontext CLI to be installed in the system PATH
- Maximum prompt length: 2000 characters
- Maximum description length: 100 characters
- Execution timeout: 120 seconds
- Output limited to 2000 lines or 50KB (whichever is reached first)
