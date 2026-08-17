/**
 * Typed error classes for the fastcontext agent.
 *
 * (D-014, SPEC §18): cancellation is signaled with `CancelledError` instead of
 * a plain `Error` whose message was matched with `includes("cancelled")` in the
 * extension entry point — string matching made the cancellation contract
 * implicit and brittle.
 *
 * (D-015, SPEC §18): `LLMAPIError` supersedes the v2 name `RequestyAPIError`
 * (a porting leftover from the retired design target). Messages and semantics
 * are unchanged.
 */

export class CancelledError extends Error {
  constructor() {
    super("Operation was cancelled");
    this.name = "CancelledError";
  }
}

export class LLMAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMAPIError";
  }
}

// (D-019, SPEC §18): fatal execution errors are thrown with typed classes
// instead of being returned as "[ERROR] ..." strings with isError: false.
// The extension maps them to tool results flagged isError: true so the host
// agent can tell a failed search apart from a (possibly empty) answer.

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
