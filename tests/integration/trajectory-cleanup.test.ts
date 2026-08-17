/**
 * Trajectory cleanup tests (D-016, SPEC §18).
 *
 * Verifies best-effort age-based pruning of trajectory JSONL files in the
 * default temp-dir location.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import { cleanupOldTrajectories } from '../../src/fastcontext-agent/index.js';

const TEST_DIR = path.join("/tmp", `fc_traj_cleanup_${randomUUID()}`);

const DAY_MS = 24 * 60 * 60 * 1000;

function touch(fileName: string, ageDays: number): string {
  const full = path.join(TEST_DIR, fileName);
  fs.writeFileSync(full, "{}\n", "utf-8");
  const t = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(full, t, t);
  return full;
}

describe("cleanupOldTrajectories (D-016)", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("removes .jsonl files older than max age, keeps recent ones", () => {
    const oldFile = touch("trajectory_old.jsonl", 8);
    const newFile = touch("trajectory_new.jsonl", 1);

    cleanupOldTrajectories(TEST_DIR, 7 * DAY_MS);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  test("respects a custom max age", () => {
    const file = touch("trajectory_mid.jsonl", 2);

    cleanupOldTrajectories(TEST_DIR, 1 * DAY_MS);

    expect(fs.existsSync(file)).toBe(false);
  });

  test("ignores non-.jsonl files", () => {
    const notJsonl = touch("notes.txt", 30);

    cleanupOldTrajectories(TEST_DIR);

    expect(fs.existsSync(notJsonl)).toBe(true);
  });

  test("does not throw when the directory does not exist", () => {
    expect(() => cleanupOldTrajectories(path.join(TEST_DIR, "does-not-exist"))).not.toThrow();
  });
});
