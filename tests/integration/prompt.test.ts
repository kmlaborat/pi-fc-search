/**
 * System prompt tests (SPEC §9 v2 record / §19 v3 active prompt)
 */

import { describe, test, expect } from 'vitest';
import { loadSystemPrompt } from '../../src/fastcontext-agent/prompt.js';

describe("System prompt (v3, SPEC §19 C-3)", () => {
  const prompt = loadSystemPrompt(process.cwd());

  test("should substitute WORK_DIR and the top-level listing", () => {
    expect(prompt).toContain(`Workspace Path: ${process.cwd()}`);
    // At least one real top-level entry of this repository must appear.
    expect(prompt).toContain("package.json");
  });

  test("should leave no unsubstituted template variables", () => {
    expect(prompt).not.toMatch(/\$\{[A-Z_]+\}/);
  });

  test("v3: should not reference the stale <query> tag", () => {
    expect(prompt).not.toContain("<query>");
  });

  test("v3: should keep the <final_answer> output contract", () => {
    expect(prompt).toContain("<final_answer>");
  });

  test("v3: should instruct existence verification before Read (KN-001 mitigation)", () => {
    expect(prompt).toContain("Verify a file exists");
  });

  test("v3: should drop the informational OS/shell block", () => {
    expect(prompt).not.toContain("OS Version");
    expect(prompt).not.toContain("Shell:");
  });
});
