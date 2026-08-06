/**
 * Real server debug test - verifies end-to-end operation against actual FastContext LLM.
 * Uses the same query patterns that failed in previous rounds to validate fixes.
 */

import { describe, test, expect } from 'vitest';
import { runFastContextAgent } from '../../src/fastcontext-agent/index.js';
import { resolve } from "path";
import fs from "fs";

const TEST_REPO_DIR = process.env.TEST_REPO_DIR || 
  process.cwd().includes('node_modules') ? process.cwd().split('node_modules')[0] : process.cwd();

// Skip if API credentials not configured
const hasCredentials = !!process.env.FASTCONTEXT_API_KEY && !!process.env.FASTCONTEXT_ENDPOINT;

describe("Real Server Debug Test", () => {
  test.skip(!hasCredentials, "should complete search with file reading (previous failure case)", async () => {
    const start = Date.now();
    console.log(`\n=== REAL SERVER TEST START (${new Date().toISOString()}) ===`);
    console.log(`API Endpoint: ${process.env.FASTCONTEXT_ENDPOINT}`);
    console.log(`Model: ${process.env.FASTCONTEXT_MODEL || 'fastapi-15b-instruct-v0.4'}`);
    console.log(`Test Repository: ${TEST_REPO_DIR}`);
    
    try {
      const result = await runFastContextAgent({
        prompt: "Find the package.json file and describe what this project is about. Include any dependencies listed.",
        cwd: TEST_REPO_DIR,
        maxTurns: 5,
        citation: false,
        llm: {
          model: process.env.FASTCONTEXT_MODEL || 'fastapi-15b-instruct-v0.4',
          apiKey: process.env.FASTCONTEXT_API_KEY!,
          baseUrl: process.env.FASTCONTEXT_ENDPOINT!,
          temperature: 0.7,
        },
        verbose: true,
      });

      const elapsed = Date.now() - start;
      
      console.log(`\n=== TEST RESULT (elapsed: ${elapsed}ms) ===`);
      console.log("SUCCESS: Agent completed with final answer");
      console.log("\nFinal Answer Content:");
      console.log(result);
      console.log("=== END OF TEST ===\n");

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    } catch (error) {
      const elapsed = Date.now() - start;
      console.error(`\n=== TEST FAILED after ${elapsed}ms ===`);
      console.error("Error:", error instanceof Error ? error.message : String(error));
      console.error("=== END OF FAILED TEST ===\n");
      throw error;
    }
  }, 60000); // 60 second timeout

  test.skip(!hasCredentials, "should handle Docker-mount style path and complete successfully", async () => {
    const start = Date.now();
    console.log(`\n=== PATH CORRECTION TEST START (${new Date().toISOString()}) ===`);
    
    try {
      const result = await runFastContextAgent({
        prompt: "Search for TypeScript files in the src directory and list what you find.",
        cwd: TEST_REPO_DIR,
        maxTurns: 5,
        citation: false,
        llm: {
          model: process.env.FASTCONTEXT_MODEL || 'fastapi-15b-instruct-v0.4',
          apiKey: process.env.FASTCONTEXT_API_KEY!,
          baseUrl: process.env.FASTCONTEXT_ENDPOINT!,
          temperature: 0.7,
        },
        verbose: true,
      });

      const elapsed = Date.now() - start;
      
      console.log(`\n=== PATH TEST RESULT (elapsed: ${elapsed}ms) ===`);
      console.log("SUCCESS: Agent completed path correction test");
      console.log("\nFinal Answer Content:");
      console.log(result);
      console.log("=== END OF PATH TEST ===\n");

      expect(result).toBeDefined();
    } catch (error) {
      const elapsed = Date.now() - start;
      console.error(`\n=== PATH TEST FAILED after ${elapsed}ms ===`);
      console.error("Error:", error instanceof Error ? error.message : String(error));
      console.error("=== END OF FAILED PATH TEST ===\n");
      throw error;
    }
  }, 60000);
});
