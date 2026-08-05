/**
 * Test setup and utilities
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

// Vitest compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const TEST_FIXTURES_DIR = resolve(__dirname, "..", "__test_fixtures__");

// Track if ripgrep is available for testing
let ripgrepAvailable: boolean | undefined;

export async function isRipgrepAvailable(): Promise<boolean> {
  if (ripgrepAvailable !== undefined) {
    return ripgrepAvailable;
  }

  try {
    // Try to import @vscode/ripgrep and get rgPath
    const rgModule = await import("@vscode/ripgrep");
    ripgrepAvailable = !!rgModule.rgPath;
    return ripgrepAvailable;
  } catch {
    // Check if system rg is available
    try {
      const { spawnSync } = await import("child_process");
      const command = process.platform === "win32" ? "where" : "which";
      const result = spawnSync(command, ["rg"], { shell: false });
      ripgrepAvailable = result.status === 0;
      return ripgrepAvailable;
    } catch {
      ripgrepAvailable = false;
      return false;
    }
  }
}

// Create fixture files and directories before tests run
export function setupTestFixtures(): void {
  if (!fs.existsSync(TEST_FIXTURES_DIR)) {
    fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
  }

  // Create subdirectories
  const srcDir = resolve(TEST_FIXTURES_DIR, "src");
  const testDir = resolve(TEST_FIXTURES_DIR, "test");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  // Create test files with known content for validation
  fs.writeFileSync(resolve(srcDir, "example.ts"), `// This is a test file
export function hello() {
  return "world";
}
`, "utf-8");

  fs.writeFileSync(resolve(srcDir, "auth.ts"), `// Authentication middleware
import { verify } from 'jsonwebtoken';

export function authenticate(token: string): boolean {
  try {
    const decoded = verify(token, "secret");
    return true;
  } catch (error) {
    return false;
  }
}
`, "utf-8");

  // Create file with many lines for truncation testing
  const manyLinesContent = Array.from({ length: 2500 }, (_, i) => 
    `// Line ${i + 1}: This is a long line that should be truncated if it exceeds the MAX_LINE_LENGTH limit of 2000 characters. Some more content here to make this line very long indeed.`
  ).join("\n");
  fs.writeFileSync(resolve(srcDir, "large.ts"), manyLinesContent, "utf-8");

  // Create files for glob testing (multiple .ts files)
  for (let i = 0; i < 120; i++) {
    fs.writeFileSync(resolve(srcDir, `test_${i}.ts`), `// Test file ${i}\n`, "utf-8");
  }

  // Create test directory with specific patterns
  const componentsDir = resolve(testDir, "components");
  fs.mkdirSync(componentsDir, { recursive: true });
  
  fs.writeFileSync(resolve(componentsDir, "Button.tsx"), `// Button component\nimport React from 'react';\nexport default function Button() { return <button>Click</button>; }\n`, "utf-8");
  fs.writeFileSync(resolve(componentsDir, "Input.tsx"), `// Input component\nimport React from 'react';\nexport default function Input() { return <input />; }\n`, "utf-8");

  // Create empty file for testing empty file handling
  fs.writeFileSync(resolve(testDir, "empty.txt"), "", "utf-8");
}

// Clean up test fixtures after tests
export function cleanupTestFixtures(): void {
  if (fs.existsSync(TEST_FIXTURES_DIR)) {
    try {
      fs.rmSync(TEST_FIXTURES_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Helper to verify Python parity - check that outputs match expected patterns
export function matchesPythonOutput(actual: string, expectedPattern: string | RegExp): boolean {
  if (typeof expectedPattern === "string") {
    return actual.includes(expectedPattern);
  }
  return expectedPattern.test(actual);
}
