import { mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { TestRun, SolidusConfig } from "./types.js";
import { ValidationError } from "./errors.js";
import { acquireLock, releaseAll } from "./lock.js";
import type { Logger } from "./logger.js";
import { validateTestRun } from "./types.js";

interface RunIndex {
  runs: Array<{ id: string; timestamp: string }>;
}

export class HistoryStore {
  private historyDir: string;
  private indexFile: string;
  private config: SolidusConfig;
  private log: Logger;

  constructor(config: SolidusConfig, log: Logger) {
    this.config = config;
    this.log = log.child("history");
    const dir = dirname(config.dbPath);
    this.historyDir = join(dir, "history");
    this.indexFile = join(dir, "index.json");
    mkdirSync(this.historyDir, { recursive: true });
  }

  /** Store a validated run. Thread/process-safe via exclusive lock. */
  saveRun(run: TestRun): void {
    const dir = dirname(this.config.dbPath);
    const lock = acquireLock(dir, "history", this.log);
    try {
      // Validate
      const errs = validateTestRun(run);
      // Validate results array
      if (errs.length > 0) throw new ValidationError(errs.join("; "));

      // Atomic write: write to temp, then rename
      const runFile = join(this.historyDir, `run-${run.id}.json`);
      const tmpFile = join(this.historyDir, `.tmp-${randomBytes(4).toString("hex")}.json`);
      const serialized = JSON.stringify(run);
      writeFileSync(tmpFile, serialized, "utf-8");
      renameSync(tmpFile, runFile);

      // Update index
      const index = this.readIndex();
      // Dedup by id (re-run of same CI run, e.g. retry)
      const existing = index.runs.findIndex(e => e.id === run.id);
      if (existing >= 0) {
        index.runs.splice(existing, 1);
      }
      index.runs.unshift({ id: run.id, timestamp: run.timestamp });

      // Trim excess
      const maxEntries = this.config.windowSize + 5;
      if (index.runs.length > maxEntries) {
        const toRemove = index.runs.splice(this.config.windowSize);
        for (const old of toRemove) {
          try { unlinkSync(join(this.historyDir, `run-${old.id}.json`)); }
          catch { /* race: another process already trimmed */ }
        }
      }

      this.writeIndexAtomic(index);
      this.log.debug(`saved run ${run.id} (${run.results.length} tests)`);
    } finally {
      lock?.release();
    }
  }

  /** Get last N runs. Returns empty array on any corruption (logs warning). */
  getRecentRuns(n: number): TestRun[] {
    const index = this.readIndex();
    const ids = index.runs.slice(0, n);
    const runs: TestRun[] = [];

    for (const entry of ids) {
      try {
        const data = readFileSync(join(this.historyDir, `run-${entry.id}.json`), "utf-8");
        const parsed = JSON.parse(data) as TestRun;
        // Basic sanity
        if (!Array.isArray(parsed.results)) continue;
        runs.push(parsed);
      } catch (err) {
        this.log.warn(`Skipping corrupt run ${entry.id}: ${(err as Error).message}`);
      }
    }
    return runs;
  }

  /** Count stored runs */
  runCount(): number {
    return this.readIndex().runs.length;
  }

  /** Delete all history. Thread-safe. */
  clear(): void {
    const dir = dirname(this.config.dbPath);
    const lock = acquireLock(dir, "history", this.log);
    try {
      mkdirSync(this.historyDir, { recursive: true }); // ensure exists
      const index = this.readIndex();
      for (const entry of index.runs) {
        try { unlinkSync(join(this.historyDir, `run-${entry.id}.json`)); } catch { /* ok */ }
      }
      this.writeIndexAtomic({ runs: [] });
    } finally {
      lock?.release();
    }
  }

  /** Release all locks. Call at exit. */
  close(): void {
    releaseAll();
  }

  private readIndex(): RunIndex {
    try {
      const raw = readFileSync(this.indexFile, "utf-8");
      return JSON.parse(raw) as RunIndex;
    } catch {
      return { runs: [] };
    }
  }

  /** Atomic index write via rename */
  private writeIndexAtomic(index: RunIndex): void {
    const dir = dirname(this.indexFile);
    const tmpFile = join(dir, `.tmp-index-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(tmpFile, JSON.stringify(index), "utf-8");
    renameSync(tmpFile, this.indexFile);
  }
}
