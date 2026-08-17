/**
 * (D-018, SPEC §18) .env key-scope tests.
 *
 * The installed-package .env loader must ONLY apply FASTCONTEXT_* keys:
 * the pre-D-018 loader wrote ANY key into process.env (and, per D-012,
 * overrode the shell environment), so a stray `PATH=...` or `NODE_ENV=...`
 * line would silently hijack the host pi process.
 *
 * These tests exercise the pure applyEnvContent() function against a
 * sandbox env object — no process.env mutation, no fs.
 */

import { describe, test, expect } from 'vitest';
import { applyEnvContent, ENV_KEY_PREFIX } from '../../src/fastcontext-agent/env.js';

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("applyEnvContent (D-018, SPEC §18)", () => {
  test("applies FASTCONTEXT_* keys", () => {
    const env = makeEnv();
    const ignored = applyEnvContent(
      `FASTCONTEXT_API_KEY=secret
FASTCONTEXT_ENDPOINT=http://example.com/v1
FASTCONTEXT_MODEL=ModelX
`,
      env
    );
    expect(env.FASTCONTEXT_API_KEY).toBe("secret");
    expect(env.FASTCONTEXT_ENDPOINT).toBe("http://example.com/v1");
    expect(env.FASTCONTEXT_MODEL).toBe("ModelX");
    expect(ignored).toEqual([]);
  });

  test("ignores non-FASTCONTEXT_* keys and reports them", () => {
    const env = makeEnv({ PATH: "/usr/bin" });
    const ignored = applyEnvContent(
      `PATH=/evil/bin
NODE_ENV=production
RIPGREP_PATH=/evil/rg
FASTCONTEXT_MODEL=ModelX
`,
      env
    );
    // The dangerous keys must NOT be applied.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.RIPGREP_PATH).toBeUndefined();
    // ... but they ARE reported so the caller can warn.
    expect(ignored.sort()).toEqual(["NODE_ENV", "PATH", "RIPGREP_PATH"]);
    // Prefixed keys still work alongside ignored ones.
    expect(env.FASTCONTEXT_MODEL).toBe("ModelX");
  });

  test("prefix must be a real prefix (FASTCONTEXT alone or FASTCONTEXTX_ do not match)", () => {
    const env = makeEnv();
    const ignored = applyEnvContent(
      `FASTCONTEXT=nope
FASTCONTEXTX_MODEL=evil
`,
      env
    );
    expect(ENV_KEY_PREFIX).toBe("FASTCONTEXT_");
    // "FASTCONTEXT=nope": key is exactly "FASTCONTEXT" (no underscore) -> ignored
    expect(env.FASTCONTEXT).toBeUndefined();
    // "FASTCONTEXTX_MODEL": does not start with "FASTCONTEXT_" -> ignored
    expect(env.FASTCONTEXTX_MODEL).toBeUndefined();
    expect(ignored.sort()).toEqual(["FASTCONTEXT", "FASTCONTEXTX_MODEL"]);
  });

  test("still overrides pre-existing env vars for FASTCONTEXT_* keys (D-012 precedence preserved)", () => {
    const env = makeEnv({ FASTCONTEXT_MODEL: "shell_old" });
    applyEnvContent(`FASTCONTEXT_MODEL=env_file\n`, env);
    expect(env.FASTCONTEXT_MODEL).toBe("env_file");
  });

  test("handles quotes, comments, and CRLF like before", () => {
    const env = makeEnv();
    applyEnvContent(
      '# comment\r\nFASTCONTEXT_API_KEY="quoted"\r\nFASTCONTEXT_MODEL=\'single\'\r\n\r\nGARBAGE=no',
      env
    );
    expect(env.FASTCONTEXT_API_KEY).toBe("quoted");
    expect(env.FASTCONTEXT_MODEL).toBe("single");
  });
});
