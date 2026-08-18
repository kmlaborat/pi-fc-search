/**
 * Tool-result eviction unit tests (D-047, SPEC §18).
 *
 * Verifies the pure `evictToolResults` function and the `Context`
 * integration:
 * - the 64 KiB budget is measured in UTF-8 bytes of the `content` STRING of
 *   each `role: "tool"` message (the exact string serialized into the LLM
 *   API request) — not a token estimate, not file bytes;
 * - eviction runs oldest-first and terminates only when the POST-stub
 *   combined byte size (stubs re-measured at their stub size) is ≤ budget;
 * - the budget is strict: even the most recent tool result is stubbed when
 *   a single result alone exceeds the budget (no unconditional keep);
 * - stubs carry re-acquisition metadata (tool_call_id preserved, tool name,
 *   arguments, original size, first line of the original output);
 * - non-tool messages are never modified; eviction is idempotent;
 * - the trajectory file keeps the FULL original tool results (eviction
 *   happens after add() wrote them).
 */

import { describe, test, expect, afterAll } from 'vitest';
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import {
  Context,
  evictToolResults,
  TOOL_RESULT_BUDGET_BYTES,
  EVICTION_STUB_MARKER,
} from '../../src/fastcontext-agent/context.js';

const BUDGET = TOOL_RESULT_BUDGET_BYTES; // 64 KiB

// ASCII content of exactly `bytes` bytes (multi-line so the stub's
// "first line" metadata is meaningful). ASCII: char count == byte count.
function makeContent(bytes: number, tag: string): string {
  const line = `${tag}|${"x".repeat(39)}\n`;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

function toolMsg(id: string, bytes: number, tag = "t"): Record<string, unknown> {
  return { role: "tool", tool_call_id: id, content: makeContent(bytes, tag) };
}

function assistantMsg(
  calls: { id: string; name: string; args: Record<string, unknown> }[]
): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  };
}

function toolBytes(history: Record<string, unknown>[]): number {
  return history.reduce(
    (sum, m) =>
      m.role === "tool" && typeof m.content === "string"
        ? sum + Buffer.byteLength(m.content, "utf8")
        : sum,
    0
  );
}

function isStub(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(EVICTION_STUB_MARKER);
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("evictToolResults (pure function, D-047)", () => {
  test("no-op when under budget: same history, zero evictions", () => {
    const history = [
      { role: "system", content: "sys" },
      { role: "user", content: "query" },
      toolMsg("c1", 10_000, "a"),
      toolMsg("c2", 10_000, "b"),
    ];
    const { history: out, report } = evictToolResults(history, BUDGET);
    expect(report.evictedCount).toBe(0);
    expect(report.bytesBefore).toBe(20_000);
    expect(report.bytesAfter).toBe(20_000);
    expect(out).toBe(history); // same reference, nothing copied
  });

  test("stubs oldest-first; most recent results stay full while they fit", () => {
    // 5 x 30 KB = 150 KB > 64 KiB. After stubbing 3 oldest: 2 x 30 KB +
    // 3 stubs (~350 B each) ≈ 61 KB ≤ budget → stop.
    const history = [
      assistantMsg([
        { id: "c1", name: "Read", args: { path: "/w/f1" } },
        { id: "c2", name: "Read", args: { path: "/w/f2" } },
        { id: "c3", name: "Read", args: { path: "/w/f3" } },
        { id: "c4", name: "Read", args: { path: "/w/f4" } },
        { id: "c5", name: "Read", args: { path: "/w/f5" } },
      ]),
      toolMsg("c1", 30_000, "one"),
      toolMsg("c2", 30_000, "two"),
      toolMsg("c3", 30_000, "three"),
      toolMsg("c4", 30_000, "four"),
      toolMsg("c5", 30_000, "five"),
    ];
    const before4 = history[4];
    const before5 = history[5];

    const { history: out, report } = evictToolResults(history, BUDGET);

    expect(report.evictedCount).toBe(3);
    expect(isStub(out[1].content)).toBe(true);
    expect(isStub(out[2].content)).toBe(true);
    expect(isStub(out[3].content)).toBe(true);
    // Most recent two untouched (same object references)
    expect(out[4]).toBe(before4);
    expect(out[5]).toBe(before5);
    expect(out[4].content).toContain("four|");
    expect(out[5].content).toContain("five|");
  });

  test("termination uses the POST-stub byte size (stubs re-measured) and the final total is ≤ budget", () => {
    // 6 x 20 KB = 120 KB. The loop must stop exactly when the
    // POST-stub total (stubs counted at their stub size) fits:
    //   k=2 stubs: 4 x 20 KB + 2 stubs ≈ 80.7 KB > budget
    //   k=3 stubs: 3 x 20 KB + 3 stubs ≈ 61.1 KB ≤ budget → stop
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const history = [
      assistantMsg(ids.map((id, i) => ({ id, name: "Read", args: { path: `/w/f${i + 1}` } }))),
      ...ids.map((id, i) => toolMsg(id, 20_000, `f${i + 1}`)),
    ];

    const { history: out, report } = evictToolResults(history, BUDGET);

    // Independent re-measurement, exactly as specified: UTF-8 bytes of the
    // `content` string of every tool message, stubs at their stub size.
    const finalTotal = toolBytes(out);
    expect(finalTotal).toBe(report.bytesAfter);
    expect(finalTotal).toBeLessThanOrEqual(BUDGET);
    expect(report.bytesBefore).toBe(120_000);

    expect(report.evictedCount).toBe(3);
    expect(isStub(out[1].content)).toBe(true); // f1 oldest...
    expect(isStub(out[2].content)).toBe(true); // f2
    expect(isStub(out[3].content)).toBe(true); // f3
    expect(out[4].content).toContain("f4|"); // ...f4/f5/f6 still full
    expect(out[5].content).toContain("f5|");
    expect(out[6].content).toContain("f6|");
  });

  test("strict budget: a single over-budget result (even the newest) is stubbed", () => {
    const history = [
      assistantMsg([{ id: "c1", name: "Grep", args: { pattern: ".*", head_limit: 2000 } }]),
      toolMsg("c1", 80_000, "huge"),
    ];
    const { history: out, report } = evictToolResults(history, BUDGET);
    expect(report.evictedCount).toBe(1);
    expect(isStub(out[1].content)).toBe(true);
    // Post-stub total (just the stub) is within the budget.
    expect(report.bytesAfter).toBeLessThanOrEqual(BUDGET);
    expect(toolBytes(out)).toBeLessThanOrEqual(BUDGET);
  });

  test("stub preserves tool_call_id and carries re-acquisition metadata", () => {
    const original = makeContent(80_000, "bigdoc"); // > 64 KiB budget
    const firstLine = original.split("\n", 1)[0];
    const history = [
      assistantMsg([{ id: "call_abc123", name: "Read", args: { path: "/w/big.md" } }]),
      { role: "tool", tool_call_id: "call_abc123", content: original },
    ];
    const { history: out } = evictToolResults(history, BUDGET);
    const stub = out[1].content as string; // history = [assistant, tool]

    // Message-level identity is preserved (only content is replaced)
    expect(out[1].tool_call_id).toBe("call_abc123");
    expect(out[1].role).toBe("tool");
    // Re-acquisition metadata
    expect(isStub(stub)).toBe(true);
    expect(stub).toContain("Read");
    expect(stub).toContain("/w/big.md"); // from the tool_call arguments
    expect(stub).toContain(`${Buffer.byteLength(original, "utf8")} bytes`); // original size
    expect(stub).toContain(firstLine); // first line of original output
  });

  test("non-tool messages are never modified", () => {
    const system = { role: "system", content: "sys prompt" };
    const user = { role: "user", content: "find the thing" };
    const assistant = assistantMsg([{ id: "c1", name: "Read", args: { path: "/w/f" } }]);
    const history = [system, user, assistant, toolMsg("c1", 80_000, "big")];

    const { history: out } = evictToolResults(history, BUDGET);

    expect(out[0]).toBe(system);
    expect(out[1]).toBe(user);
    expect(out[2]).toBe(assistant); // tool_calls structure intact
    expect(JSON.stringify(assistant.tool_calls)).toBe(
      JSON.stringify(out[2].tool_calls)
    );
  });

  test("idempotent: a second pass evicts nothing", () => {
    const history = [
      assistantMsg([{ id: "c1", name: "Read", args: { path: "/w/f" } }]),
      toolMsg("c1", 80_000, "big"),
      toolMsg("c2", 80_000, "bigger"),
    ];
    const first = evictToolResults(history, BUDGET);
    const second = evictToolResults(first.history, BUDGET);
    expect(second.report.evictedCount).toBe(0);
    expect(second.report.bytesAfter).toBe(first.report.bytesAfter);
    expect(second.history).toBe(first.history);
  });

  test("budget is UTF-8 bytes, not JS string length (CJK counted 3x)", () => {
    // Each content: 22,000 CJK chars = 66,001 UTF-8 bytes but only
    // 22,001 in JS string length. Two of them: 132,002 bytes (> 64 KiB
    // budget, and each alone is over budget so BOTH must be evicted) vs
    // 44,002 chars (< budget: under string-length accounting nothing
    // would be evicted).
    const contentA = "あ".repeat(22_000) + "\n";
    const contentB = "い".repeat(22_000) + "\n";
    const history = [
      assistantMsg([
        { id: "c1", name: "Read", args: { path: "/w/a" } },
        { id: "c2", name: "Read", args: { path: "/w/b" } },
      ]),
      { role: "tool", tool_call_id: "c1", content: contentA },
      { role: "tool", tool_call_id: "c2", content: contentB },
    ];

    // Sanity: the fixture must actually exceed the budget in BYTES while
    // staying under it in JS string length (that is the point of the test).
    expect(Buffer.byteLength(contentA + contentB, "utf8")).toBeGreaterThan(BUDGET);
    expect((contentA + contentB).length).toBeLessThan(BUDGET);

    const { history: out, report } = evictToolResults(history, BUDGET);

    expect(report.evictedCount).toBe(2);
    expect(toolBytes(out)).toBeLessThanOrEqual(BUDGET);
    expect(isStub(out[1].content)).toBe(true); // history = [assistant, tool, tool]
    expect(isStub(out[2].content)).toBe(true);
  });
});

describe("Context.evictToolResults (history + trajectory, D-047)", () => {
  test("stubs the history but the trajectory keeps the full originals", async () => {
    const tmpDir = path.join("/tmp", `fc_evict_ctx_${randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    tmpDirs.push(tmpDir);

    try {
      const trajFile = path.join(tmpDir, "trajectory.jsonl");
      const ctx = new Context(trajFile);

      const sentinelA = "SENTINEL_A_9f31c7";
      const sentinelB = "SENTINEL_B_4a8d2e";
      const contentA = `line 1 ${sentinelA}\n` + "a".repeat(40_000) + "\n";
      const contentB = "b".repeat(40_000) + `\nlast line ${sentinelB}\n`;

      await ctx.add({ role: "system", content: "sys" });
      await ctx.add({ role: "user", content: "query" });
      await ctx.add(assistantMsg([
        { id: "c1", name: "Read", args: { path: "/w/a" } },
        { id: "c2", name: "Read", args: { path: "/w/b" } },
      ]) as any);
      await ctx.add([
        { role: "tool", content: contentA, tool_call_id: "c1" },
        { role: "tool", content: contentB, tool_call_id: "c2" },
      ]);

      // ~80 KB of tool results > 64 KiB budget → oldest gets stubbed.
      const report = ctx.evictToolResults();
      expect(report.evictedCount).toBe(1);
      expect(report.bytesAfter).toBeLessThanOrEqual(BUDGET);

      // History (what gets sent to the LLM) carries the stub...
      const messages = ctx.getMessages();
      const toolMsgs = messages.filter((m: any) => m.role === "tool");
      expect(isStub(toolMsgs[0].content)).toBe(true);
      expect(toolMsgs[0].tool_call_id).toBe("c1");
      expect(toolMsgs[1].content).toContain(sentinelB); // newest kept full

      // ...but the trajectory recorded the FULL original before eviction.
      const trajectory = fs.readFileSync(trajFile, "utf8");
      expect(trajectory).toContain(sentinelA);
      expect(trajectory).toContain(sentinelB);
      expect(trajectory).not.toContain(EVICTION_STUB_MARKER);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
