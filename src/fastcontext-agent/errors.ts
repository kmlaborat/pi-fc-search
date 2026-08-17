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

// (D-029, SPEC §18) A context-window exceedance (D-027) gets its own typed
// class so the extension can recognize it by type (not by message text) and
// retry the search once with a reduced turn budget, instead of relying on
// the host agent to re-run the tool.
export class ContextWindowError extends LLMAPIError {
  constructor(message: string) {
    super(message);
    this.name = "ContextWindowError";
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

// (D-042, SPEC §18) burning the full turn budget (including the D-007
// forced final turn) without a final answer is a FAILED search, not an
// answer. It used to resolve with the plain string "No final answer after
// N turns.", which the extension returned as a successful (isError: false)
// result — contradicting the D-019 principle that failed searches must be
// flaggable. The message text is the unchanged Requirement B exit message.
export class NoFinalAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoFinalAnswerError";
  }
}
