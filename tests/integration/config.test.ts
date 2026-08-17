/**
 * FASTCONTEXT_* configuration resolution tests (SPEC §15.4, §19 v3)
 */

import { describe, test, expect, afterEach } from 'vitest';
import {
  loadFastContextConfig,
  validateEndpointUrl,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_SECONDS,
} from '../../src/fastcontext-agent/config.js';

const VARS = [
  "FASTCONTEXT_MODEL",
  "FASTCONTEXT_API_KEY",
  "FASTCONTEXT_ENDPOINT",
  "FASTCONTEXT_TEMPERATURE",
  "FASTCONTEXT_TOP_P",
  "FASTCONTEXT_MAX_TOKENS",
  "FASTCONTEXT_TIMEOUT_SECONDS",
] as const;

describe("loadFastContextConfig (SPEC §15.4)", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of VARS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  function clearAll() {
    for (const key of VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }

  test("should return v3 defaults when nothing is set", () => {
    clearAll();
    const cfg = loadFastContextConfig();
    expect(cfg.model).toBe("");
    expect(cfg.apiKey).toBe("");
    expect(cfg.baseUrl).toBe("");
    expect(cfg.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(cfg.topP).toBe(DEFAULT_TOP_P);
    expect(cfg.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(cfg.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    expect(DEFAULT_TEMPERATURE).toBe(0.2); // v3 default (v2 was 1.0)
    expect(DEFAULT_TOP_P).toBe(0.95); // D-030 (was a code constant)
  });

  test("should read all variables when set", () => {
    clearAll();
    process.env.FASTCONTEXT_MODEL = "m";
    process.env.FASTCONTEXT_API_KEY = "k";
    process.env.FASTCONTEXT_ENDPOINT = "http://x/v1";
    process.env.FASTCONTEXT_TEMPERATURE = "0.5";
    process.env.FASTCONTEXT_TOP_P = "0.8";
    process.env.FASTCONTEXT_MAX_TOKENS = "4096";
    process.env.FASTCONTEXT_TIMEOUT_SECONDS = "600";

    const cfg = loadFastContextConfig();
    expect(cfg.model).toBe("m");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.baseUrl).toBe("http://x/v1");
    expect(cfg.temperature).toBe(0.5);
    expect(cfg.topP).toBe(0.8);
    expect(cfg.maxTokens).toBe(4096);
    expect(cfg.timeoutSeconds).toBe(600);
  });

  test("should fall back to defaults for invalid values (warn, never crash)", () => {
    clearAll();
    process.env.FASTCONTEXT_TEMPERATURE = "hot";
    process.env.FASTCONTEXT_TOP_P = "1.5"; // above the 0-1 range
    process.env.FASTCONTEXT_MAX_TOKENS = "-5";
    process.env.FASTCONTEXT_TIMEOUT_SECONDS = "1"; // below the 5s minimum

    const cfg = loadFastContextConfig();
    expect(cfg.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(cfg.topP).toBe(DEFAULT_TOP_P);
    expect(cfg.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(cfg.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
  });

  test("should reject out-of-range temperature", () => {
    clearAll();
    process.env.FASTCONTEXT_TEMPERATURE = "9";
    expect(loadFastContextConfig().temperature).toBe(DEFAULT_TEMPERATURE);
  });

  test("should reject out-of-range top_p (negative or > 1)", () => {
    clearAll();
    process.env.FASTCONTEXT_TOP_P = "-0.1";
    expect(loadFastContextConfig().topP).toBe(DEFAULT_TOP_P);
    process.env.FASTCONTEXT_TOP_P = "2";
    expect(loadFastContextConfig().topP).toBe(DEFAULT_TOP_P);
  });
});

describe("validateEndpointUrl (D-026, SPEC §18)", () => {
  test("accepts http(s) base URLs", () => {
    expect(validateEndpointUrl("https://example.com/v1")).toBeNull();
    expect(validateEndpointUrl("http://localhost:8080")).toBeNull();
    expect(validateEndpointUrl("  https://example.com/v1  ")).toBeNull();
  });

  test("rejects values that are not absolute URLs", () => {
    expect(validateEndpointUrl("example.com/v1")).toMatch(/not a valid URL/);
    expect(validateEndpointUrl("")).toMatch(/not a valid URL/);
    expect(validateEndpointUrl("not a url at all")).toMatch(/not a valid URL/);
  });

  test("rejects non-http(s) protocols", () => {
    expect(validateEndpointUrl("ftp://example.com")).toMatch(/only http/);
    expect(validateEndpointUrl("file:///etc/passwd")).toMatch(/only http/);
  });
});
