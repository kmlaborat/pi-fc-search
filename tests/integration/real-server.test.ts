/**
 * Opt-in real-server integration test.
 *
 * Exercises the full agent loop end-to-end against a real OpenAI-compatible
 * endpoint. Skipped automatically unless FASTCONTEXT_API_KEY and
 * FASTCONTEXT_ENDPOINT are set in the environment AND the configured model
 * can currently serve a completion (one minimal probe request per run,
 * D-049), so CI and local runs without an LLM server — or with a server that
 * has not loaded the model — are unaffected.
 *
 * Run manually with, e.g.:
 *   FASTCONTEXT_ENDPOINT=http://localhost:8080/v1 FASTCONTEXT_MODEL=... npm test
 */

import { describe, test, expect } from 'vitest';
import { runFastContextAgent } from '../../src/fastcontext-agent/index.js';
import { resolve } from "path";
import { probeModelAvailable } from "../utils/model-probe.js";

const TEST_REPO_DIR = resolve(process.env.FC_TEST_REPO_DIR || process.cwd());

// Skip if API credentials not configured. The import of runFastContextAgent
// above has already run loadEnvFile() (ESM imports evaluate before module
// body), so package-.env values participate.
const hasCredentials = !!process.env.FASTCONTEXT_API_KEY && !!process.env.FASTCONTEXT_ENDPOINT;

// (D-049, SPEC §18) Credentials alone are not enough: a configured-but-
// unloaded model (e.g. "no router for requested model") used to turn this
// suite red for an environmental reason. Probe the model once and skip the
// whole suite when it cannot currently serve a completion. The probe never
// throws, so a broken endpoint can only skip, never fail.
const modelAvailable = hasCredentials
  ? await probeModelAvailable(
      process.env.FASTCONTEXT_ENDPOINT!,
      process.env.FASTCONTEXT_API_KEY ?? "",
      process.env.FASTCONTEXT_MODEL || "test-model"
    )
  : false;

if (hasCredentials && !modelAvailable) {
  console.info(
    `[real-server] skipping: model "${process.env.FASTCONTEXT_MODEL || "test-model"}" ` +
    `is not currently available at ${process.env.FASTCONTEXT_ENDPOINT} (probe request failed).`
  );
}

describe.skipIf(!hasCredentials || !modelAvailable)("Real server integration (opt-in)", () => {
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
