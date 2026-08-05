/**
 * ToolSet tests - verify SPEC §8.4 behavioral requirements
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { ToolSet, MAX_TOOLRUN_TIMEOUT } from '../../src/fastcontext-agent/tools/types.js';
import { ReadTool } from '../../src/fastcontext-agent/tools/read.js';
import { GlobTool } from '../../src/fastcontext-agent/tools/glob.js';
import { GrepTool } from '../../src/fastcontext-agent/tools/grep.js';
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures_toolset__");

function setupTestFixtures(): void {
  fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(resolve(TEST_FIXTURES_DIR, "test.ts"), "export function test() {}\n", "utf-8");
}

function cleanupTestFixtures(): void {
  if (fs.existsSync(TEST_FIXTURES_DIR)) {
    try {
      fs.rmSync(TEST_FIXTURES_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

describe("ToolSet", () => {
  let toolset: ToolSet;

  beforeAll(() => {
    setupTestFixtures();
    toolset = new ToolSet([
      new ReadTool(),
      new GlobTool(),
      new GrepTool()
    ], TEST_FIXTURES_DIR);
  });

  afterAll(() => {
    cleanupTestFixtures();
  });

  describe("Schema generation", () => {
    test("should generate schema list for all tools", () => {
      const schemas = toolset.schemaList();
      expect(schemas.length).toBe(3);
    });
  });

  describe("Tool call execution", () => {
    test("should execute valid tool call", async () => {
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_123",
          name: "Read",
          arguments: JSON.stringify({
            path: join(TEST_FIXTURES_DIR, "test.ts")
          })
        }]
      };

      const results = await toolset.call(message as any);
      expect(results.length).toBe(1);
      expect(results[0].failed).toBe(false);
      expect(results[0].toolCallId).toBe("call_123");
    });

    test("should handle unknown tool name", async () => {
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_123",
          name: "NonExistentTool",
          arguments: "{}"
        }]
      };

      const results = await toolset.call(message as any);
      expect(results.length).toBe(1);
      expect(results[0].failed).toBe(true);
      expect(results[0].output).toContain("Tool `NonExistentTool` not found");
    });

    test("should handle invalid JSON arguments", async () => {
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_123",
          name: "Read",
          arguments: "not valid json {{{"
        }]
      };

      const results = await toolset.call(message as any);
      expect(results.length).toBe(1);
      expect(results[0].failed).toBe(true);
      expect(results[0].output).toContain("arguments are invalid");
    });

    test("should return empty results for message without tool calls", async () => {
      const message = {
        role: "assistant",
        content: "Here is my response"
      };

      const results = await toolset.call(message as any);
      expect(results.length).toBe(0);
    });
  });

  describe("Timeout handling", () => {
    test("should have timeout constant set to 10 seconds", () => {
      expect(MAX_TOOLRUN_TIMEOUT).toBe(10);
    });
  });
});
