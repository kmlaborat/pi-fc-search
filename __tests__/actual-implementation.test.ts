/**
 * Test the actual implementation in extensions/index.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Actual Implementation Verification", () => {
  it("should have correct formatToSpec implementation", () => {
    const indexPath = join(process.cwd(), "extensions", "index.ts");
    const content = readFileSync(indexPath, "utf-8");

    // Verify formatToSpec function exists
    assert.ok(
      content.includes("function formatToSpec"),
      "formatToSpec function should exist"
    );

    // Verify SPEC format sections
    assert.ok(
      content.includes('"### Summary"'),
      "Should have ### Summary section"
    );
    assert.ok(
      content.includes('"### Relevant Locations"'),
      "Should have ### Relevant Locations section"
    );

    // Verify No Matching Code Found uses SPEC format (not [ERROR])
    const noMatchMatch = content.match(/if\s*\(!stdoutData\.trim\(\)\s*\|\|\s*stdoutData\.trim\(\)\.length\s*===\s*0\)\s*\{[\s\S]*?resolve\(`([\s\S]*?)`\)/);
    if (noMatchMatch) {
      const response = noMatchMatch[1];
      assert.ok(
        response.includes("### Summary"),
        "No match response should contain ### Summary"
      );
      assert.ok(
        !response.includes("[ERROR]"),
        "No match response should NOT contain [ERROR]"
      );
    }
  });

  it("should have correct error handling for CLI not found", () => {
    const indexPath = join(process.cwd(), "extensions", "index.ts");
    const content = readFileSync(indexPath, "utf-8");

    assert.ok(
      content.includes('"not found"') || content.includes('"ENOENT"'),
      "Should handle CLI not found error"
    );
    assert.ok(
      content.includes("fastcontext command not found"),
      "Should return proper error message"
    );
  });

  it("should have correct timeout configuration", () => {
    const indexPath = join(process.cwd(), "extensions", "index.ts");
    const content = readFileSync(indexPath, "utf-8");

    assert.ok(
      content.includes("120"),
      "Should have 120 second timeout"
    );
    assert.ok(
      content.includes("execution timeout exceeded"),
      "Should have timeout error message"
    );
  });

  it("should use shell: false for security", () => {
    const indexPath = join(process.cwd(), "extensions", "index.ts");
    const content = readFileSync(indexPath, "utf-8");

    assert.ok(
      content.includes("shell: false"),
      "Should use shell: false for security"
    );
  });

  it("should not import typebox", () => {
    const indexPath = join(process.cwd(), "extensions", "index.ts");
    const content = readFileSync(indexPath, "utf-8");

    assert.ok(
      !content.includes('from "typebox"'),
      "Should not import typebox"
    );
    assert.ok(
      !content.includes("from 'typebox'"),
      "Should not import typebox (single quotes)"
    );
  });

  it("should use JSON Schema format", () => {
    const indexPath = join(process.cwd(), "extensions", "index.ts");
    const content = readFileSync(indexPath, "utf-8");

    assert.ok(
      content.includes('type: "object"') || content.includes('"type": "object"'),
      "Should use JSON Schema type: object"
    );
    assert.ok(
      content.includes('"description"') && content.includes('"prompt"'),
      "Should have description and prompt properties"
    );
  });

  it("should have AbortSignal handling", () => {
    const indexPath = join(process.cwd(), "extensions", "index.ts");
    const content = readFileSync(indexPath, "utf-8");

    assert.ok(
      content.includes("AbortSignal") || content.includes("signal"),
      "Should handle AbortSignal"
    );
    assert.ok(
      content.includes("addEventListener") && content.includes("abort"),
      "Should listen for abort events"
    );
  });
});
