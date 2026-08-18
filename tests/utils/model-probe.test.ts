/**
 * Model availability probe tests (D-049, SPEC §18)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { probeModelAvailable } from './model-probe.js';

describe("probeModelAvailable (D-049, SPEC §18)", () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { path: string; authorization: string | undefined; body: any } | null = null;
  let respondStatus = 200;
  let respondBody: () => unknown = () => ({ choices: [{ message: { role: "assistant", content: "." } }] });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let body: any = null;
        try { body = JSON.parse(raw); } catch { /* leave null */ }
        lastRequest = { path: req.url ?? "", authorization: req.headers.authorization, body };
        res.writeHead(respondStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(respondBody()));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(() => {
    // fetch (undici) keeps keep-alive connections in its pool; close them so
    // the server (and the vitest process) can actually exit.
    server?.closeAllConnections?.();
    server?.close();
  });

  test("returns true for a 2xx completion response", async () => {
    respondStatus = 200;
    expect(await probeModelAvailable(baseUrl, "", "test-model")).toBe(true);
  });

  test("returns false when the model has no router (404)", async () => {
    respondStatus = 404;
    respondBody = () => ({ error: "no router for requested model", src: "llama-swap" });
    expect(await probeModelAvailable(baseUrl, "", "test-model")).toBe(false);
    // The probe must hit the chat completions endpoint with the model.
    expect(lastRequest!.path).toBe("/v1/chat/completions");
    expect(lastRequest!.body.model).toBe("test-model");
    respondBody = () => ({ choices: [{ message: { role: "assistant", content: "." } }] });
  });

  test("returns false when the endpoint is unreachable", async () => {
    // A port with nothing listening (listen+close immediately frees it).
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    expect(
      await probeModelAvailable(`http://127.0.0.1:${port}/v1`, "", "test-model")
    ).toBe(false);
  });

  test("sends the Bearer header only when an API key is present", async () => {
    respondStatus = 200;
    await probeModelAvailable(baseUrl, "sk-probe", "test-model");
    expect(lastRequest!.authorization).toBe("Bearer sk-probe");
    await probeModelAvailable(baseUrl, "", "test-model");
    expect(lastRequest!.authorization).toBeUndefined();
  });

  test("trailing slash on the base URL is tolerated", async () => {
    respondStatus = 200;
    expect(await probeModelAvailable(`${baseUrl}/`, "", "test-model")).toBe(true);
    expect(lastRequest!.path).toBe("/v1/chat/completions");
  });
});
