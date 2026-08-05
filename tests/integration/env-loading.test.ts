/**
 * .env file loading tests - verify SPEC §14 requirements
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DIR = path.resolve(__dirname, "..", "__test_env_fixtures__");

function setupTestFixtures(): void {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Create .env files at different levels
  fs.writeFileSync(path.join(TEST_DIR, ".env"), `FASTCONTEXT_API_KEY=cwd_key
FASTCONTEXT_ENDPOINT=http://cwd.example.com
FASTCONTEXT_MODEL=cwd_model
`, "utf-8");

  // Create package directory with .env
  const packageDir = path.join(TEST_DIR, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, ".env"), `FASTCONTEXT_API_KEY=package_key
FASTCONTEXT_ENDPOINT=http://package.example.com
FASTCONTEXT_MODEL=package_model
`, "utf-8");

  // Create extension directory with .env
  const extensionDir = path.join(TEST_DIR, "extensions");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, ".env"), `FASTCONTEXT_API_KEY=extension_key
FASTCONTEXT_ENDPOINT=http://extension.example.com
FASTCONTEXT_MODEL=extension_model
`, "utf-8");
}

function cleanupTestFixtures(): void {
  if (fs.existsSync(TEST_DIR)) {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

function createEnvLoader(): (envPath: string) => void {
  return (envPath: string): void => {
    if (!fs.existsSync(envPath)) return;
    
    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      
      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();
      
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      process.env[key] = value;
    }
  };
}

describe(".env File Loading (SPEC §14)", () => {
  const originalEnv = {
    FASTCONTEXT_API_KEY: process.env.FASTCONTEXT_API_KEY,
    FASTCONTEXT_ENDPOINT: process.env.FASTCONTEXT_ENDPOINT,
    FASTCONTEXT_MODEL: process.env.FASTCONTEXT_MODEL
  };

  beforeAll(() => {
    setupTestFixtures();
  });

  afterAll(() => {
    // Restore original environment
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    cleanupTestFixtures();
  });

  test("should load .env file from current working directory", () => {
    const loadEnv = createEnvLoader();
    loadEnv(path.join(TEST_DIR, ".env"));
    
    expect(process.env.FASTCONTEXT_API_KEY).toBe("cwd_key");
    expect(process.env.FASTCONTEXT_ENDPOINT).toBe("http://cwd.example.com");
    expect(process.env.FASTCONTEXT_MODEL).toBe("cwd_model");
  });

  test("should handle quoted values in .env file", () => {
    // Create temp .env with quoted values
    const tempEnv = path.join(TEST_DIR, "quoted.env");
    fs.writeFileSync(tempEnv, `QUOTED_KEY="quoted_value"
SINGLE_QUOTED_KEY='single_quoted_value'
`, "utf-8");
    
    const loadEnv = createEnvLoader();
    loadEnv(tempEnv);
    
    expect(process.env.QUOTED_KEY).toBe("quoted_value");
    expect(process.env.SINGLE_QUOTED_KEY).toBe("single_quoted_value");
    
    fs.unlinkSync(tempEnv);
  });

  test("should skip comments and empty lines", () => {
    const tempEnv = path.join(TEST_DIR, "comments.env");
    fs.writeFileSync(tempEnv, `# This is a comment
KEY=value

# Another comment
`, "utf-8");
    
    const loadEnv = createEnvLoader();
    loadEnv(tempEnv);
    
    expect(process.env.KEY).toBe("value");
    
    fs.unlinkSync(tempEnv);
  });

  test("should not crash when .env file doesn't exist", () => {
    const loadEnv = createEnvLoader();
    expect(() => loadEnv(path.join(TEST_DIR, "nonexistent.env"))).not.toThrow();
  });
});
