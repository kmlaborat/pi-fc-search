/**
 * (D-057, SPEC §18) /reload-fc-env runtime .env re-read tests.
 *
 * reloadEnvFile() must be re-runnable: unlike loadEnvFile() (once-guarded at
 * module init), it performs the file read on EVERY call so a .env edit takes
 * effect without a pi restart. Combined with D-037's per-call
 * loadFastContextConfig(), the next fc_search call uses the corrected values.
 *
 * The real package .env lives at a path derived from env.ts (not injectable),
 * so these tests exercise the same parsing/application code through
 * applyEnvContent() against a sandbox env object, plus the extension's
 * /reload-fc-env command wiring with reloadEnvFile mocked (the vi.mock factory
 * runs before any module import in this file — no cross-test cache pollution).
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  applyEnvContent,
  ENV_KEY_PREFIX,
  getEnvPath,
} from "../../src/fastcontext-agent/env.js";
import type { ReloadEnvResult } from "../../src/fastcontext-agent/env.js";

// Mock the reloader for the command-wiring tests. The pure parsing tests
// above use applyEnvContent directly and are unaffected.
const mockReload = vi.fn<(result?: Partial<ReloadEnvResult>) => ReloadEnvResult>();
vi.mock("../../src/fastcontext-agent/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/fastcontext-agent/env.js")>();
  return { ...actual, reloadEnvFile: (...a: unknown[]) => mockReload(...(a as [Partial<ReloadEnvResult>?])) };
});

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("reload semantics (D-057, SPEC §18)", () => {
  test("getEnvPath resolves the package-root .env", () => {
    // env.ts lives in src/fastcontext-agent/ → two levels up is the package root.
    const p = getEnvPath();
    expect(p.endsWith(".env")).toBe(true);
    expect(p).toContain("pi-fc-search");
  });

  test("re-applying changed .env content overrides previous values (D-012 precedence, every call)", () => {
    const env = makeEnv({ FASTCONTEXT_MODEL: "first_load" });
    // First load
    applyEnvContent(`FASTCONTEXT_MODEL=first_load\nFASTCONTEXT_ENDPOINT=http://a/v1\n`, env);
    expect(env.FASTCONTEXT_MODEL).toBe("first_load");
    // Edited .env re-applied — the new value must win without any reset.
    applyEnvContent(`FASTCONTEXT_MODEL=second_load\nFASTCONTEXT_ENDPOINT=http://a/v1\n`, env);
    expect(env.FASTCONTEXT_MODEL).toBe("second_load");
  });

  test("keys removed from the .env are NOT removed from process.env (overwrite-only contract)", () => {
    const env = makeEnv();
    applyEnvContent(`FASTCONTEXT_MODEL=kept\nFASTCONTEXT_ENDPOINT=http://a/v1\n`, env);
    // Edited .env drops FASTCONTEXT_ENDPOINT entirely.
    applyEnvContent(`FASTCONTEXT_MODEL=kept\n`, env);
    expect(env.FASTCONTEXT_MODEL).toBe("kept");
    // The stale value remains — documented D-057 semantics (option A).
    expect(env.FASTCONTEXT_ENDPOINT).toBe("http://a/v1");
  });

  test("non-prefixed keys are still ignored on reload (D-018)", () => {
    const env = makeEnv({ PATH: "/usr/bin" });
    const ignored = applyEnvContent(`PATH=/evil\nFASTCONTEXT_MODEL=m\n`, env);
    expect(env.PATH).toBe("/usr/bin");
    expect(ignored).toEqual(["PATH"]);
    expect(env.FASTCONTEXT_MODEL).toBe("m");
  });

  test("applied-key derivation matches applyEnvContent parsing rules (quotes, comments, CRLF, prefix filter)", () => {
    // Mirrors the key-derivation loop in reloadEnvFile(): same skip/parse
    // rules as applyEnvContent, collecting prefixed keys.
    const derive = (content: string): string[] => {
      const keys: string[] = [];
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex <= 0) continue;
        const key = trimmed.substring(0, eqIndex).trim();
        if (key.startsWith(ENV_KEY_PREFIX)) keys.push(key);
      }
      return keys;
    };

    const content = [
      "# comment",
      `FASTCONTEXT_API_KEY="quoted"`,
      "FASTCONTEXT_MODEL='single'",
      "",
      "GARBAGE=no",
      "FASTCONTEXTX_MODEL=evil",
      "FASTCONTEXT_TIMEOUT_SECONDS=120",
    ].join("\r\n");

    const env = makeEnv();
    const ignored = applyEnvContent(content, env);
    const applied = derive(content);

    expect(applied.sort()).toEqual([
      "FASTCONTEXT_API_KEY",
      "FASTCONTEXT_MODEL",
      "FASTCONTEXT_TIMEOUT_SECONDS",
    ]);
    expect(ignored.sort()).toEqual(["FASTCONTEXTX_MODEL", "GARBAGE"]);
    // Values were actually applied for exactly the derived keys.
    for (const key of applied) {
      expect(env[key]).toBeDefined();
    }
  });
});

describe("/reload-fc-env command wiring (D-057, SPEC §18)", () => {
  beforeEach(() => {
    mockReload.mockReset();
  });

  function makeMockCtx() {
    return {
      ui: { notify: vi.fn(), confirm: vi.fn(), select: vi.fn(), input: vi.fn() },
      cwd: process.cwd(),
      mode: "tui" as const,
      hasUI: true,
    };
  }

  async function runReloadCommand() {
    // Import AFTER vi.mock registration so the extension captures the mock.
    const mod = await import("../../extensions/index.js");
    const registerCommand = vi.fn();
    mod.default({ on: vi.fn(), registerCommand, registerTool: vi.fn() } as any);
    const call = registerCommand.mock.calls.find((c: unknown[]) => c[0] === "reload-fc-env");
    expect(call).toBeDefined();
    const ctx = makeMockCtx();
    await (call![1].handler as (args: string, ctx: unknown) => Promise<void>)("", ctx);
    return { ctx, notifyTexts: (ctx.ui.notify as any).mock.calls };
  }

  test("registers a /reload-fc-env command", async () => {
    mockReload.mockReturnValue({ envPath: "/pkg/.env", found: true, appliedKeys: [], ignoredKeys: [] });
    const mod = await import("../../extensions/index.js");
    const registerCommand = vi.fn();
    mod.default({ on: vi.fn(), registerCommand, registerTool: vi.fn() } as any);
    expect(registerCommand.mock.calls.map((c: unknown[]) => c[0])).toContain("reload-fc-env");
  });

  test("notifies applied keys and effective config on success", async () => {
    mockReload.mockReturnValue({
      envPath: "/pkg/.env",
      found: true,
      appliedKeys: ["FASTCONTEXT_ENDPOINT", "FASTCONTEXT_MODEL"],
      ignoredKeys: [],
    });
    process.env.FASTCONTEXT_ENDPOINT = "http://effective.example/v1";
    process.env.FASTCONTEXT_MODEL = "effective-model";
    try {
      const { ctx } = await runReloadCommand();
      expect(mockReload).toHaveBeenCalledTimes(1);
      const texts = (ctx.ui.notify as any).mock.calls.map((c: unknown[]) => c[0]);
      expect(texts.some((t: string) => t.includes("FASTCONTEXT_ENDPOINT, FASTCONTEXT_MODEL"))).toBe(true);
      expect(texts.some((t: string) => t.includes("http://effective.example/v1") && t.includes("effective-model"))).toBe(true);
    } finally {
      delete process.env.FASTCONTEXT_ENDPOINT;
      delete process.env.FASTCONTEXT_MODEL;
    }
  });

  test("warns when no .env is found", async () => {
    mockReload.mockReturnValue({ envPath: "/pkg/.env", found: false, appliedKeys: [], ignoredKeys: [] });
    const { ctx } = await runReloadCommand();
    expect(
      (ctx.ui.notify as any).mock.calls.some((c: unknown[]) => c[1] === "warning" && String(c[0]).includes("no .env found"))
    ).toBe(true);
  });

  test("warns about ignored non-prefixed keys", async () => {
    mockReload.mockReturnValue({
      envPath: "/pkg/.env",
      found: true,
      appliedKeys: ["FASTCONTEXT_MODEL"],
      ignoredKeys: ["PATH", "NODE_ENV"],
    });
    const { ctx } = await runReloadCommand();
    expect(
      (ctx.ui.notify as any).mock.calls.some((c: unknown[]) => c[1] === "warning" && String(c[0]).includes("PATH, NODE_ENV"))
    ).toBe(true);
  });

  test("notes empty .env (no FASTCONTEXT_* keys)", async () => {
    mockReload.mockReturnValue({ envPath: "/pkg/.env", found: true, appliedKeys: [], ignoredKeys: [] });
    const { ctx } = await runReloadCommand();
    expect(
      (ctx.ui.notify as any).mock.calls.some((c: unknown[]) => String(c[0]).includes("no FASTCONTEXT_* keys"))
    ).toBe(true);
  });
});
