/**
 * Model availability probe for the opt-in real-server tests.
 *
 * (D-049, SPEC §18) The opt-in tests are gated only on FASTCONTEXT_* being
 * set, so a configured-but-unloaded model (e.g. a local server that answers
 * "no router for requested model") turned the test run red for an
 * environmental reason. This probe makes the gate check the MODEL, not just
 * the credentials.
 */

/**
 * Probe whether `model` can currently serve a completion at `baseUrl`.
 *
 * Sends a minimal chat completion (`max_completion_tokens: 1` — one token,
 * tiny prompt) to `${baseUrl}/chat/completions` with a bounded timeout.
 *
 * Returns true only for a 2xx response. Every other outcome — non-2xx
 * (e.g. 404 "no router for requested model"), network failure, timeout —
 * returns false; the probe never throws, so a broken endpoint can only
 * SKIP the opt-in tests, never fail them.
 */
export async function probeModelAvailable(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs = 20_000
): Promise<boolean> {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
      }),
      signal: controller.signal,
    });
    // Drain is unnecessary for the caller; the body is discarded.
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
