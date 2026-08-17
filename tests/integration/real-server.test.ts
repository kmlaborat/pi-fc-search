/**
 * Opt-in real-server integration test.
 *
 * Exercises the full agent loop end-to-end against a real OpenAI-compatible
 * endpoint. Skipped automatically unless FASTCONTEXT_API_KEY and
 * FASTCONTEXT_ENDPOINT are set in the environment, so CI and local runs
 * without an LLM server are unaffected.
 *
 * Run manually with, e.g.:
 *   FASTCONTEXT_ENDPOINT=http://localhost:8080/v1 FASTCONTEXT_MODEL=... npm test
 */

import { describe, test, expect } from 'vitest';
import { runFastContextAgent } from '../../src/fastcontext-agent/index.js';
import { resolve } from "path";

const TEST_REPO_DIR = resolve(process.env.FC_TEST_REPO_DIR || process.cwd());

// Skip if API credentials not configured
const hasCredentials = !!process.env.FASTCONTEXT_API_KEY && !!process.env.FASTCONTEXT_ENDPOINT;

describe.skipIf(!hasCredentials)("Real server integration (opt-in)", () => {
  test("completes a search that reads files", async () => {
    const result = await runFastContextAgent({
      prompt: "Find the package.json file and describe what this project is about. Include any dependencies listed.",
      cwd: TEST_REPO_DIR,
      maxTurns: 5,
      citation: false,
      llm: {
        model: process.env.FASTCONTEXT_MODEL || "test-model",
        apiKey: process.env.FASTCONTEXT_API_KEY!,
        baseUrl: process.env.FASTCONTEXT_ENDPOINT!,
      },
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 60000);

  test("completes a search that lists files", async () => {
    const result = await runFastContextAgent({
      prompt: "Search for TypeScript files in the src directory and list what you find.",
      cwd: TEST_REPO_DIR,
      maxTurns: 5,
      citation: false,
      llm: {
        model: process.env.FASTCONTEXT_MODEL || "test-model",
        apiKey: process.env.FASTCONTEXT_API_KEY!,
        baseUrl: process.env.FASTCONTEXT_ENDPOINT!,
      },
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  }, 60000);
});
