/**
 * fc_search input validation tests (incl. D-043, SPEC §18)
 *
 * validateInput is exported from the extension entry point; these tests
 * exercise its contract directly (the tool's execute() delegates to it).
 */

import { describe, test, expect } from "vitest";
import { validateInput } from "../../extensions/index.js";

const VALID = { description: "Find auth", prompt: "Locate the auth middleware." };

describe("validateInput", () => {
  test("accepts valid input and applies defaults", () => {
    expect(validateInput(VALID)).toEqual({
      description: "Find auth",
      prompt: "Locate the auth middleware.",
      max_turns: 15,
      use_citation: false,
    });
  });

  test("rejects non-object arguments", () => {
    expect(() => validateInput(null)).toThrow(/Invalid tool arguments/);
    expect(() => validateInput("string")).toThrow(/Invalid tool arguments/);
  });

  test("rejects missing or empty description/prompt", () => {
    expect(() => validateInput({ ...VALID, description: "" })).toThrow(
      /'description'/
    );
    expect(() => validateInput({ prompt: VALID.prompt })).toThrow(
      /'description'/
    );
    expect(() => validateInput({ ...VALID, prompt: "" })).toThrow(/'prompt'/);
  });

  // (D-043, SPEC §18) a whitespace-only string is missing for all practical
  // purposes: pre-D-043 it passed validation and burned the full turn and
  // timeout budgets on an unanswerable search.
  test("rejects whitespace-only description and prompt (D-043, SPEC §18)", () => {
    expect(() => validateInput({ ...VALID, description: "   \t\n " })).toThrow(
      /'description'/
    );
    expect(() => validateInput({ ...VALID, prompt: "  " })).toThrow(/'prompt'/);
  });

  test("rejects oversized description/prompt", () => {
    expect(() =>
      validateInput({ ...VALID, description: "x".repeat(101) })
    ).toThrow(/100/);
    expect(() =>
      validateInput({ ...VALID, prompt: "x".repeat(2001) })
    ).toThrow(/2000/);
  });

  test("validates max_turns and use_citation", () => {
    expect(() => validateInput({ ...VALID, max_turns: 0 })).toThrow(/between 1 and 50/);
    expect(() => validateInput({ ...VALID, max_turns: 51 })).toThrow(/between 1 and 50/);
    expect(() => validateInput({ ...VALID, max_turns: 1.5 })).toThrow(/integer/);
    expect(() => validateInput({ ...VALID, use_citation: "yes" })).toThrow(/boolean/);
    expect(validateInput({ ...VALID, max_turns: 1, use_citation: true })).toMatchObject({
      max_turns: 1,
      use_citation: true,
    });
  });
});
