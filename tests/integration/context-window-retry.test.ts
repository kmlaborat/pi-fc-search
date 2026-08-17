/**
 * Context-window overflow auto-retry tests (D-029, SPEC §18).
 *
 * Verifies the extension's executeAgent() behavior when the sub-agent's
 * conversation exceeds the model's context window (D-027): one automatic
 * retry with the turn budget halved, guarded by the turn-count threshold
 * and the abort state, with the ORIGINAL error reported when the retry
 * also fails.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

// The extension module resolves FC_CONFIG at load time — set the required
// variables before importing it (module registry is per-test-file in vitest).
process.env.FASTCONTEXT_ENDPOINT = "http://localhost:1/v1";
process.env.FASTCONTEXT_MODEL = "test-model";

vi.mock("../../src/fastcontext-agent/index.js", () => ({
  runFastContextAgent: vi.fn(),
}));

import { runFastContextAgent } from "../../src/fastcontext-agent/index.js";
import {
  ContextWindowError,
  LLMAPIError,
} from "../../src/fastcontext-agent/errors.js";

const OVERFLOW =
  "The search conversation exceeded the model's context window. " +
  "Re-run with a smaller max_turns or a more focused prompt.";

const mockedRun = vi.mocked(runFastContextAgent);

describe("executeAgent context-window auto-retry (D-029, SPEC §18)", () => {
  beforeEach(() => {
    mockedRun.mockReset();
  });

  test("retries once with the turn budget halved and returns the retry result", async () => {
    const { executeAgent } = await import("../../extensions/index.js");

    mockedRun
      .mockRejectedValueOnce(new ContextWindowError(OVERFLOW))
      .mockResolvedValueOnce("retry answer");

    const result = await executeAgent("find x", process.cwd(), undefined, 15);

    expect(result).toBe("retry answer");
    expect(mockedRun).toHaveBeenCalledTimes(2);
    expect(mockedRun.mock.calls[0][0]).toMatchObject({ maxTurns: 15 });
    expect(mockedRun.mock.calls[1][0]).toMatchObject({ maxTurns: 8 });
  });

  test("halves odd budgets with ceil (e.g. 10 -> 5, 7 -> 4)", async () => {
    const { executeAgent } = await import("../../extensions/index.js");

    mockedRun
      .mockRejectedValueOnce(new ContextWindowError(OVERFLOW))
      .mockResolvedValueOnce("ok");
    await executeAgent("find x", process.cwd(), undefined, 7);
    expect(mockedRun.mock.calls[1][0]).toMatchObject({ maxTurns: 4 });

    mockedRun
      .mockRejectedValueOnce(new ContextWindowError(OVERFLOW))
      .mockResolvedValueOnce("ok");
    await executeAgent("find x", process.cwd(), undefined, 10);
    // Second call in this test is call #2 overall
    expect(mockedRun.mock.calls[3][0]).toMatchObject({ maxTurns: 5 });
  });

  test("does not retry when the budget is already small (< 4 turns)", async () => {
    const { executeAgent } = await import("../../extensions/index.js");

    mockedRun.mockRejectedValueOnce(new ContextWindowError(OVERFLOW));

    await expect(
      executeAgent("find x", process.cwd(), undefined, 3)
    ).rejects.toThrow(ContextWindowError);
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });

  test("reports the ORIGINAL overflow error when the retry also overflows", async () => {
    const { executeAgent } = await import("../../extensions/index.js");

    const original = new ContextWindowError(OVERFLOW);
    mockedRun
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new ContextWindowError(OVERFLOW));

    await expect(
      executeAgent("find x", process.cwd(), undefined, 15)
    ).rejects.toThrow(ContextWindowError);
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });

  test("does not retry other LLM API errors", async () => {
    const { executeAgent } = await import("../../extensions/index.js");

    mockedRun.mockRejectedValueOnce(new LLMAPIError("LLM API call failed (500): boom"));

    await expect(
      executeAgent("find x", process.cwd(), undefined, 15)
    ).rejects.toThrow("boom");
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });
});
