/**
 * Tool-result eviction — end-to-end agent integration test (D-047, D-048).
 *
 * Runs the full agent loop against a stubbed fetch (no real LLM) with
 * fixture files sized so that three whole-file Reads exceed the 64 KiB
 * tool-result history budget. Verifies:
 *
 * 1. Eviction runs before every LLM call: by the 2nd request the oldest
 *    tool results are stubs (with re-acquisition metadata) and the newest
 *    is full; the combined tool-result content bytes in every request are
 *    ≤ TOOL_RESULT_BUDGET_BYTES (post-stub re-measured).
 * 2. REGRESSION BOUND (2026-08-18 incident): the serialized request body
 *    of every LLM call stays ≤ 100 KiB. The incident request was
 *    164,028 bytes and its ~95s cold prefill blew the 120s execution
 *    timeout. This bound asserts that incident-class request sizes cannot
 *    recur under the cap + eviction design. It is a regression bound
 *    against that observed failure, NOT a general performance guarantee
 *    (no bytes→tokens→seconds conversion is part of the spec; prefill
 *    rates vary per server).
 * 3. The trajectory file keeps the FULL original tool results (the evicted
 *    file's mid-content sentinel must be present verbatim).
 * 4. The search still completes with a final answer.
 */

import { describe, test, expect, vi, afterAll } from 'vitest';
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import {
  runFastContextAgent,
} from '../../src/fastcontext-agent/index.js';
import {
  TOOL_RESULT_BUDGET_BYTES,
  EVICTION_STUB_MARKER,
} from '../../src/fastcontext-agent/context.js';

// Regression bound from the 2026-08-18 incident: the failed request was
// 164,028 bytes; 100 KiB leaves ~64 KiB of margin below it.
const INCIDENT_REGRESSION_BOUND_BYTES = 100 * 1024;

const requestLog: { url: string; rawBody: string; body: any }[] = [];

function readCall(id: string, filePath: string) {
  return {
    id,
    type: "function",
    function: { name: "Read", arguments: JSON.stringify({ path: filePath }) },
  };
}

function okResponse(message: any) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve({ choices: [{ message, finish_reason: "stop" }] }),
    text: () => Promise.resolve(""),
  };
}

/** ~57 KB file: 900 lines of ~60 chars (well under the 64 KiB Read cap,
 * with margin so stub sizes cannot tip the post-stub total over budget). */
function makeFileContent(tag: string, lines = 900): string {
  const out: string[] = [`// ${tag} header`];
  for (let i = 2; i <= lines; i++) {
    out.push(`${tag} line ${i}: ${"z".repeat(45)}`);
  }
  return out.join("\n");
}

function toolContentBytes(messages: any[]): number {
  return messages.reduce(
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

describe("eviction in the agent loop (D-047/D-048)", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test("bounds every LLM request, keeps the trajectory complete, and finishes", async () => {
    const uuid = randomUUID().slice(0, 8);
    const tmpDir = path.join("/tmp", `fc_evict_agent_${uuid}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const sentinelF1 = `SENTINEL_F1_${uuid}`;
    const midF1 = `MID_F1_${uuid}`;
    const pathF1 = path.join(tmpDir, "f1.txt");
    const pathF2 = path.join(tmpDir, "f2.txt");
    const pathF3 = path.join(tmpDir, "f3.txt");
    const pathF4 = path.join(tmpDir, "f4.txt");

    // f1 carries unique sentinels (line 2 and mid-file) so we can prove the
    // trajectory kept the FULL original even after f1 was evicted.
    const f1Lines = makeFileContent("F1").split("\n");
    f1Lines[1] = sentinelF1;
    f1Lines[500] = midF1;
    fs.writeFileSync(pathF1, f1Lines.join("\n"), "utf-8");
    fs.writeFileSync(pathF2, makeFileContent("F2"), "utf-8");
    fs.writeFileSync(pathF3, makeFileContent("F3"), "utf-8");
    fs.writeFileSync(pathF4, makeFileContent("F4"), "utf-8");

    const trajectoryFile = path.join(tmpDir, "trajectory.jsonl");

    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      const rawBody = options.body as string;
      const body = JSON.parse(rawBody);
      requestLog.push({ url, rawBody, body });

      switch (requestLog.length) {
        case 1:
          // Turn 1: read three ~55 KB files in one batch (the incident shape).
          return okResponse({
            role: "assistant",
            content: null,
            tool_calls: [
              readCall("c1", pathF1),
              readCall("c2", pathF2),
              readCall("c3", pathF3),
            ],
          });
        case 2:
          // Turn 2: one more read.
          return okResponse({
            role: "assistant",
            content: null,
            tool_calls: [readCall("c4", pathF4)],
          });
        default:
          // Turn 3: final answer.
          return okResponse({
            role: "assistant",
            content: `Read all four files.\n\n<final_answer>\n${pathF1}:1-900\n</final_answer>`,
          });
      }
    });

    let result: string;
    try {
      requestLog.length = 0;
      result = await runFastContextAgent({
        prompt: "Read the four files and report.",
        cwd: tmpDir,
        maxTurns: 5,
        citation: false,
        trajectoryFile,
        llm: { model: "test-model", apiKey: "k", baseUrl: "http://localhost:9999/v1" },
      });

      // --- Assertions: must run while the trajectory file still exists ---

      // Three LLM calls.
      expect(requestLog.length).toBe(3);

    // --- 1. Per-request tool-result budget (post-stub re-measured) --------
    for (const { body } of requestLog) {
      expect(toolContentBytes(body.messages)).toBeLessThanOrEqual(TOOL_RESULT_BUDGET_BYTES);
    }

    // Turn-2 request: the 3 reads (~165 KB) were reduced to budget. The two
    // oldest are stubs carrying re-acquisition metadata; the newest is full.
    const turn2Tools = requestLog[1].body.messages.filter((m: any) => m.role === "tool");
    expect(turn2Tools.length).toBe(3);
    expect(isStub(turn2Tools[0].content)).toBe(true);
    expect(isStub(turn2Tools[1].content)).toBe(true);
    expect(isStub(turn2Tools[2].content)).toBe(false);
    expect(turn2Tools[2].content).toContain("F3 line 900:");
    // Stub metadata: tool_call_id preserved, original size + first line kept.
    expect(turn2Tools[0].tool_call_id).toBe("c1");
    expect(turn2Tools[0].content).toContain("Read");
    expect(turn2Tools[0].content).toContain(pathF1);
    expect(turn2Tools[0].content).toMatch(/original size \d+ bytes/);

    // Turn-3 request: after the 4th read, the now-2nd-newest result (f3) is
    // also stubbed; the newest (f4) is full.
    const turn3Tools = requestLog[2].body.messages.filter((m: any) => m.role === "tool");
    expect(turn3Tools.length).toBe(4);
    expect(turn3Tools[3].content).toContain("F4 line 900:");
    expect(isStub(turn3Tools[2].content)).toBe(true);

    // --- 2. Regression bound: no incident-class (164,028-byte) request ----
    for (const { rawBody } of requestLog) {
      expect(Buffer.byteLength(rawBody, "utf8")).toBeLessThanOrEqual(INCIDENT_REGRESSION_BOUND_BYTES);
    }

    // --- 3. Trajectory kept the full originals ----------------------------
    const trajectory = fs.readFileSync(trajectoryFile, "utf8");
    expect(trajectory).toContain(sentinelF1);
    expect(trajectory).toContain(midF1); // mid-file: only present if FULL original
    // No tool-role message in the trajectory may be a stub. (The system
    // prompt legitimately MENTIONS the marker — it teaches the model to
    // recognize stubs — so only tool messages are checked.)
    for (const line of trajectory.trim().split("\n")) {
      const entry = JSON.parse(line);
      if (entry.role === "tool") {
        expect(entry.content).not.toContain(EVICTION_STUB_MARKER);
      }
    }

    // --- 4. The search completed ------------------------------------------
    expect(result).toContain("<final_answer>");
    expect(result).toContain("f1.txt");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
