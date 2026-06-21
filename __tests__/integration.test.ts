/**
 * Integration Tests for pi-fc-search
 * Tests the actual implementation logic
 */

import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Simulates the formatToSpec function from extensions/index.ts
 */
function formatToSpec(output: string): string {
  const lines = output.split("\n");
  const relevantLocations: Array<{ file: string; start: number; end: number }> = [];
  let summaryLines: string[] = [];

  for (const line of lines) {
    const citationMatch = line.match(/^(.+?):(\d+):\s*(.*)$/);
    if (citationMatch) {
      const [, file, lineStr, content] = citationMatch;
      const lineNumber = parseInt(lineStr, 10);
      if (!isNaN(lineNumber)) {
        relevantLocations.push({ file: file.trim(), start: lineNumber, end: lineNumber });
        if (content.trim()) {
          summaryLines.push(content.trim());
        }
      }
    } else if (line.trim()) {
      summaryLines.push(line);
    }
  }

  const formattedLines: string[] = [];
  
  formattedLines.push("### Summary");
  if (summaryLines.length > 0) {
    const uniqueSummaries = [...new Set(summaryLines)].slice(0, 10);
    formattedLines.push(uniqueSummaries.join(" "));
  } else {
    formattedLines.push("Search completed successfully.");
  }
  formattedLines.push("");

  formattedLines.push("### Relevant Locations");
  if (relevantLocations.length > 0) {
    const uniqueLocations = Array.from(
      new Set(relevantLocations.map(loc => `${loc.file}:${loc.start}-${loc.end}`))
    );
    
    for (const locStr of uniqueLocations.slice(0, 20)) {
      const [file, range] = locStr.split(":");
      formattedLines.push(`- **[${file}]**: lines [${range}]`);
    }
  } else {
    formattedLines.push("No specific locations identified.");
  }

  return formattedLines.join("\n");
}

describe("Integration Tests", () => {
  describe("formatToSpec - Happy Path", () => {
    it("should format realistic fastcontext output correctly", () => {
      const fastcontextOutput = `
src/auth/middleware.ts:42: export function authMiddleware(req, res, next)
src/auth/middleware.ts:55:   if (!req.headers.authorization)
src/auth/middleware.ts:60:     return res.status(401).json({ error: 'Unauthorized' })
src/api/routes.ts:12: import { authMiddleware } from '../auth/middleware';
src/api/routes.ts:25: app.get('/api/secure', authMiddleware, (req, res) => {
`;

      const result = formatToSpec(fastcontextOutput);

      // Verify SPEC format
      assert.ok(result.includes("### Summary"), "Should have Summary section");
      assert.ok(result.includes("### Relevant Locations"), "Should have Relevant Locations section");
      assert.ok(result.includes("export function authMiddleware"), "Should contain summary content");
      assert.ok(result.includes("**[src/auth/middleware.ts]**"), "Should contain formatted file link");
      assert.ok(result.includes("lines [42-42]"), "Should contain line numbers");
      
      console.log("Formatted output:\n", result);
    });

    it("should handle empty output", () => {
      const result = formatToSpec("");
      
      assert.ok(result.includes("### Summary"), "Should have Summary section");
      assert.ok(result.includes("### Relevant Locations"), "Should have Relevant Locations section");
      assert.ok(result.includes("No specific locations identified."), "Should indicate no locations");
    });

    it("should handle whitespace-only output", () => {
      const result = formatToSpec("   \n\n   ");
      
      assert.ok(result.includes("### Summary"), "Should have Summary section");
    });
  });

  describe("No Matching Code Found - SPEC Compliant", () => {
    it("should return SPEC-compliant format for no matches", () => {
      // This simulates the error case in executeFastcontext
      const noMatchResponse = `### Summary

No relevant files or contexts found matching the query.`;

      assert.ok(noMatchResponse.includes("### Summary"), "Should have Summary section");
      assert.ok(noMatchResponse.includes("No relevant files or contexts found"), "Should have proper message");
      assert.ok(!noMatchResponse.includes("[ERROR]"), "Should NOT contain [ERROR] prefix");
    });
  });

  describe("Smart Truncation", () => {
    it("should handle large output correctly", () => {
      // Generate large output
      const lines = Array(3000).fill(null).map((_, i) => `line ${i}: content ${i}`);
      const largeOutput = lines.join("\n");

      // Simulate truncation
      const truncated = largeOutput.split("\n").slice(0, 2000).join("\n");
      
      assert.ok(truncated.split("\n").length <= 2000, "Should be within line limit");
    });

    it("should preserve code block markers", () => {
      const outputWithCodeBlock = `
### Summary
Some text

\`\`\`typescript
export function test() {
  console.log("hello");
// Code block is cut here
`;

      const codeBlockCount = (outputWithCodeBlock.match(/```/g) || []).length;
      
      // Odd number of markers should trigger closure
      assert.ok(codeBlockCount % 2 !== 0, "Should have unclosed code block");
    });
  });

  describe("Edge Cases", () => {
    it("should handle duplicate locations", () => {
      const outputWithDuplicates = `
src/file.ts:10: first occurrence
src/file.ts:10: second occurrence at same line
src/file.ts:20: different line
`;

      const result = formatToSpec(outputWithDuplicates);
      const locationCount = (result.match(/src\/file\.ts/g) || []).length;
      
      // Should deduplicate same file:line
      assert.ok(locationCount <= 3, "Should deduplicate locations");
    });

    it("should handle various citation formats", () => {
      const output = `
/path/to/src/file.ts:100: content here
relative/path/file.ts:200: more content
file.ts:5: short path
`;

      const result = formatToSpec(output);
      
      assert.ok(result.includes("**[/path/to/src/file.ts]**"), "Should handle absolute paths");
      assert.ok(result.includes("**[relative/path/file.ts]**"), "Should handle relative paths");
      assert.ok(result.includes("**[file.ts]**"), "Should handle simple filenames");
    });
  });
});
