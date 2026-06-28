/**
 * Test quarantine system.
 *
 * Manages a JSON file (`.solidus-quarantine`) listing flaky tests that should be
 * excluded from CI gate. Supports Jest/Vitest pattern generation so teams can
 * merge code while flaky tests are being fixed.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { QuarantineEntry } from "./core/types.js";
import { acquireLock, releaseAll } from "./core/lock.js";
import type { Logger } from "./core/logger.js";

const QUARANTINE_FILENAME = ".solidus-quarantine";

export class FileQuarantineStore {
  private filePath: string;
  private lockDir: string;
  private log: Logger;

  constructor(dbPath: string, log: Logger) {
    const dir = dirname(dbPath);
    this.filePath = join(dir, QUARANTINE_FILENAME);
    this.lockDir = dir;
    this.log = log.child("quarantine");
  }

  /** Load quarantine entries. Returns empty array on any error. */
  load(): QuarantineEntry[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e): e is QuarantineEntry => {
        if (!e || typeof e !== "object") return false;
        const entry = e as Record<string, unknown>;
        return (
          typeof entry.name === "string" &&
          typeof entry.file === "string" &&
          typeof entry.reason === "string" &&
          typeof entry.quarantinedAt === "string" &&
          typeof entry.flakeCount === "number"
        );
      });
    } catch {
      this.log.warn("Could not read quarantine file, treating as empty");
      return [];
    }
  }

  /** Save quarantine entry (dedup by file::name). Returns true if added new. */
  add(entry: QuarantineEntry): boolean {
    const lock = acquireLock(this.lockDir, "quarantine", this.log);
    try {
      const entries = this.load();
      const key = `${entry.file}::${entry.name}`;
      const existing = entries.findIndex(e => `${e.file}::${e.name}` === key);
      if (existing >= 0) {
        // Update existing entry: increment flakeCount, update reason
        const current = entries[existing]!;
        entries[existing] = {
          name: current.name,
          file: current.file,
          reason: entry.reason,
          quarantinedAt: entry.quarantinedAt,
          flakeCount: current.flakeCount + 1,
        };
        this.writeAtomic(entries);
        return false; // already existed
      }
      entries.push(entry);
      this.writeAtomic(entries);
      return true;
    } finally {
      lock?.release();
    }
  }

  /** Remove a quarantine entry by file::name. Returns true if removed. */
  remove(file: string, name: string): boolean {
    const lock = acquireLock(this.lockDir, "quarantine", this.log);
    try {
      const entries = this.load();
      const key = `${file}::${name}`;
      const idx = entries.findIndex(e => `${e.file}::${e.name}` === key);
      if (idx < 0) return false;
      entries.splice(idx, 1);
      this.writeAtomic(entries);
      return true;
    } finally {
      lock?.release();
    }
  }

  /** Check if a test is quarantined */
  isQuarantined(file: string, name: string): boolean {
    const entries = this.load();
    const key = `${file}::${name}`;
    return entries.some(e => `${e.file}::${e.name}` === key);
  }

  /** Generate Jest testPathIgnorePatterns snippet */
  toJestPattern(): string {
    const entries = this.load();
    if (entries.length === 0) return "// No quarantined tests";
    const patterns = entries.map(e => escapeGlob(e.file));
    return [
      "// solidus: auto-generated quarantine patterns",
      `// ${entries.length} test(s) quarantined`,
      "testPathIgnorePatterns: [",
      ...patterns.map(p => `  ${JSON.stringify(p)},`),
      "],",
    ].join("\n");
  }

  /** Generate Vitest exclude snippet */
  toVitestPattern(): string {
    return this.toJestPattern().replace("testPathIgnorePatterns", "exclude");
  }

  /** Generate a simple text listing of quarantined tests */
  toListing(): string {
    const entries = this.load();
    if (entries.length === 0) return "No quarantined tests.";
    return entries.map(e =>
      `${e.file} :: ${e.name}\n  Reason: ${e.reason}\n  Quarantined: ${e.quarantinedAt} (${e.flakeCount}x flaky)`
    ).join("\n");
  }

  /** Clear all quarantine entries */
  clear(): void {
    const lock = acquireLock(this.lockDir, "quarantine", this.log);
    try {
      this.writeAtomic([]);
    } finally {
      lock?.release();
    }
  }

  /** Release all locks */
  close(): void {
    releaseAll();
  }

  private writeAtomic(entries: QuarantineEntry[]): void {
    const dir = dirname(this.filePath);
    const tmpFile = join(dir, `.tmp-q-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(tmpFile, JSON.stringify(entries, null, 2) + "\n", "utf-8");
    renameSync(tmpFile, this.filePath);
    this.log.debug(`wrote ${entries.length} quarantine entries`);
  }
}

function escapeGlob(filePath: string): string {
  return filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
