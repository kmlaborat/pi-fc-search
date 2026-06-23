# Design Specification: `pi-fc-search` Integration Package for `pi`

This design specification defines the implementation requirements for integrating Microsoft's repository exploration sub-agent tool `fastcontext` as a native package for the AI agent platform `pi`, named **`pi-fc-search`**.
The design is extremely lightweight and robust, considering the architectural language boundaries (coexistence of TypeScript and Python) and eliminating all external dependencies.

## 1. Purpose and Architecture Overview

### 1.1 Background and Problem

When AI coding agents handle large source code repositories, naively scanning all files or performing imprecise `grep` operations leads to excessive consumption of LLM context tokens, resulting in response degradation and reduced code modification accuracy. Particularly in "cold start states" where the agent doesn't know what exists and where, the problem of agents getting lost in the codebase frequently occurs.

### 1.2 Solution

Implement Microsoft's fast repository exploration tool `fastcontext` (Python-based) as an extension package **`pi-fc-search`** for the `pi` agent environment (Node.js / TypeScript-based). This frees the main coding agent from the tedious work of exploring vast codebases, allowing it to focus on pinpointing target lines and creating modification code.

> **💡 Language Stack and Dependency Clarification**
> This package is implemented as a `pi` extension operating in **TypeScript (Node.js)** environment, safely calling the `fastcontext` CLI from the **Python** environment installed on the system as a child process.
> To maximize maintainability and lightness, **no external npm modules are used, and implementation relies solely on Node.js standard features.**

---

## 2. Input Specifications (Inputs & Constraints)

### 2.1 Extension / Tool Input Parameters (JSON Schema)

The input structure when the main agent calls this tool via the `pi` platform. To prevent overly large inputs, a maximum character limit (`maxLength`) is explicitly added for `prompt`. Additional parameters allow fine-tuning search behavior.

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

1. **Runtime Environment**: The `fastcontext` CLI (Python-based) must be installed in the `$PATH` of the execution container environment and be executable standalone.
2. **Working Directory (cwd)**: Commands must be executed in the root directory of the target repository for exploration.
3. **Authentication Environment Variables**: Environment variables required for LLM API calls made internally by `fastcontext` must be configured. The extension supports multiple configuration methods:
   - Shell environment variables (exported before running pi)
   - `.env` file in the package directory (automatically loaded at module initialization)

   The extension automatically loads `.env` from the following locations (in order of precedence):
   1. Current working directory (`./.env`)
   2. Package directory (`./extensions/../.env`)
   3. Extension directory (`./extensions/.env`)

   **Environment Variable Mapping**:
   - `FASTCONTEXT_API_KEY` → mapped to `API_KEY` for CLI
   - `FASTCONTEXT_ENDPOINT` → mapped to `BASE_URL` for CLI
   - `FASTCONTEXT_MODEL` → mapped to `MODEL` for CLI

   This mapping prevents conflicts when the same environment is used by other projects.

4. **Prohibition of External Dependencies (Zero-Dependency)**: To prevent dependency bloat from `node_modules` and breaking changes due to future specification changes, **no external npm modules (`axios`, `lodash`, `zod`, etc.) are permitted**. All input/output validation, parsing, and formatting must be completed using only Node.js standard libraries (`node:util`, `node:path`, `node:child_process`, etc.) and the built-in `fetch`.

---

## 3. Output Specifications (Outputs & Guarantees)

### 3.1 Output Data Structure

The tool returns the **raw output from fastcontext CLI** without any processing, truncation, or formatting. The format depends on the `use_citation` parameter:

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

The main agent receives the **unmodified CLI output** and interprets it directly. No additional formatting or tag manipulation is applied by the wrapper.

### 3.2 Output Handling - Pass-Through Design

**No truncation or processing is applied to the output.** The extension passes through:
- All stdout data exactly as received from `fastcontext`
- `<final_answer>` tags and exploration logs in their original form
- Complete error messages from stderr on failure

This design ensures that:
1. The agent can see the complete search context including intermediate reasoning
2. `<final_answer>` blocks are never corrupted by truncation
3. The agent receives full visibility into the search process for better decision-making

> **🔧 Design Rationale**
> Previous versions implemented output truncation (2000 lines / 50KB limits) and smart trimming to preserve code blocks. However, this processing was identified as a source of hallucination and confusion for the agent. The current pass-through design eliminates all such processing to provide the agent with complete, unfiltered information.

### 3.3 Guarantees

1. All output file paths must be relative paths from the current directory (`cwd`) at execution time or valid absolute paths.
2. The line ranges (line ranges) presented must be valid line numbers actually existing in the target file.

---

## 4. Invariants

The following conditions must always be maintained throughout the tool's execution lifecycle.

1. **State Isolation**: `fastcontext` execution must not make any changes to the code in the repository, the state of the file system, or the Git history (strictly read-only behavior).
2. **High Consistency**: For the same repository state and same `prompt` input, by setting the underlying LLM's configuration to `temperature=0.0`, the consistency of returned file lists and context should be maximized (minimal differences due to the probabilistic nature of LLMs are permitted).
3. **Non-blocking Concurrency**: Even during execution of this tool, the main agent must not be prevented from executing other read operations concurrently in the same environment.

---

## 5. Exception Handling (Failure Cases)

In the TypeScript wrapper handler layer, capture child process errors and return them to the `pi` runtime in the following format.

| Occurrence Condition | Expected System Behavior / Returned Error Format |
| --- | --- |
| **CLI Not Installed** | Capture standard error output and return the following error:<br><br>`[ERROR] fastcontext command not found. Ensure the package is properly initialized.` |
| **Missing Parameters** | Error detected by `pi` runtime validation (JSON Schema). Prompt for re-request to LLM or return `Invalid tool arguments`. |
| **No Matching Code Found** | Normal completion (Status 200) and return empty output from fastcontext. The agent interprets the empty result. |
| **LLM API Error / Process Failure** | Detected when the process returns a non-normal exit code (not 0). Return raw stderr output for agent interpretation: `<raw stderr content>` |
| **Timeout**<br><br>(Exceeding 120 seconds) | Send `SIGKILL` to the child process via `node:child_process` to force termination, and return the following:<br><br>`[ERROR] pi-fc-search execution timeout exceeded (120 seconds).` |

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

Create `package.json` that declares metadata and tool interfaces recognizable by the `pi` agent platform. Ensure that `dependencies` is completely empty (`{}`).

#### Task 3: Tool Execution Wrapper Handler Implementation (TypeScript)

Using `spawn` from `node:child_process`, implement logic that receives input and executes `fastcontext -q "<prompt>" --citation` as an external process. Collect standard output **without truncation or processing**, and return raw data to the agent.

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

The extension maps `FASTCONTEXT_*` variables to CLI-expected names:

```typescript
const childEnv = {
  ...process.env,
  API_KEY: FASTCONTEXT_API_KEY,
  BASE_URL: FASTCONTEXT_ENDPOINT,
  MODEL: FASTCONTEXT_MODEL,
};
```

This prevents conflicts when the same environment is used by other projects.

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
