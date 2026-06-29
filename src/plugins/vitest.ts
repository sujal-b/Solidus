/**
 * Vitest reporter plugin.
 *
 * Auto-collects test results via Vitest's native Reporter API,
 * stores in solidus history, and prints flake summary.
 *
 * Usage in vitest.config.ts:
 *   import SolidusReporter from 'solidus/dist/plugins/vitest.js';
 *   export default {
 *     reporters: ['default', new SolidusReporter({ dbPath: '.solidus/history.db' })],
 *   };
 *
 * Or via config object:
 *   reporters: ['default', ['solidus/dist/plugins/vitest.js', { dbPath: '.solidus/history.db' }]],
 *
 * Pure ESM. Works with Vitest 1.x+.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TestResult, TestRun, SolidusConfig, FlakeReport } from "../core/types.js";
import { DEFAULTS } from "../core/types.js";
import { HistoryStore } from "../core/history.js";
import { FlakeDetector } from "../core/detector.js";
import { Logger } from "../core/logger.js";

interface VitestReporterOptions {
  dbPath?: string;
  autoQuarantine?: boolean;
  logLevel?: string;
}

interface VitestTask {
  id: string;
  name: string;
  type: "test" | "suite" | "bench";
  mode: "run" | "skip" | "todo" | "only";
  result?: {
    state: "pass" | "fail" | "skip" | "pending" | "run";
    duration?: number;
    errors?: Array<{ message?: string; stack?: string }>;
  };
  file?: { filepath: string };
  tasks?: VitestTask[];
}

class SolidusVitestReporter {
  private results: TestResult[] = [];
  private startTime = Date.now();
  private config: SolidusConfig;
  private store: HistoryStore;
  private log: Logger;

  constructor(_globalConfig: unknown, opts: VitestReporterOptions) {
    this.config = {
      ...DEFAULTS,
      dbPath: opts.dbPath ?? DEFAULTS.dbPath,
      autoQuarantine: opts.autoQuarantine ?? DEFAULTS.autoQuarantine,
      logLevel: (opts.logLevel ?? "info") as SolidusConfig["logLevel"],
    };
    this.log = new Logger(this.config.logLevel, "solidus:vitest");
    this.store = new HistoryStore(this.config, this.log);
  }

  /**
   * Called by Vitest after all tests in a run complete.
   * files: Array of File (TestSuite) objects.
   */
  onTestRunEnd(files: VitestTask[]): void {
    for (const file of files) {
      this.collectTests(file, file.file?.filepath ?? "unknown");
    }

    const run: TestRun = {
      id: `vitest_${this.startTime}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      results: this.results,
      commit: process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA ?? undefined,
      branch: process.env.GITHUB_REF_NAME ?? process.env.CI_COMMIT_BRANCH ?? undefined,
      ciRunId: process.env.GITHUB_RUN_ID ?? process.env.CI_PIPELINE_ID ?? undefined,
    };

    try {
      this.store.saveRun(run);
    } catch (err) {
      this.log.error(`Failed to save run: ${(err as Error).message}`);
      return;
    }

    const recent = this.store.getRecentRuns(this.config.windowSize);
    if (recent.length < 2) {
      this.log.info(`Collecting history (${recent.length}/${this.config.windowSize} runs)`);
      return;
    }

    const detector = new FlakeDetector(this.config);
    const report = detector.analyze(recent);

    const dir = dirname(this.config.dbPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/latest-report.json`, JSON.stringify(report, null, 2));

    this.printSummary(report);
  }

  /**
   * Recursively walk Vitest task tree collecting test results.
   */
  private collectTests(task: VitestTask, filePath: string): void {
    if (task.type === "test") {
      const status = task.result?.state === "pass" ? "pass" as const
        : task.result?.state === "fail" ? "fail" as const
        : "skip" as const;

      const error = task.result?.errors?.[0]
        ? task.result.errors[0].message ?? task.result.errors[0].stack
        : undefined;

      this.results.push({
        name: task.name || "unnamed test",
        file: filePath,
        status,
        durationMs: task.result?.duration ?? 0,
        error: error?.slice(0, 1000) ?? undefined,
      });
    }

    // Recurse into sub-tasks (describe blocks, nested suites)
    if (task.tasks) {
      // Use file path from child if it has one
      const childFile = task.file?.filepath ?? filePath;
      for (const child of task.tasks) {
        this.collectTests(child, childFile);
      }
    }
  }

  private printSummary(report: { stable: number; flaky: number; broken: number; quarantined: number; flakes: FlakeReport[] }): void {
    if (report.flaky === 0 && report.broken === 0) {
      console.log(`\n\x1b[32m━━━ solidus ━━━ ${report.stable} all stable ━━━━━━━━━━━\x1b[0m\n`);
      return;
    }

    const lines: string[] = [`\n\x1b[33m━━━ solidus ━━━\x1b[0m`];
    lines.push(`  ${report.stable} stable  ${report.flaky} flaky  ${report.broken} broken  ${report.quarantined} quarantined`);

    for (const f of report.flakes) {
      if (f.classification === "flaky") {
        lines.push(`  \x1b[33m⚠\x1b[0m ${f.name} (${f.passCount}/${f.totalRuns} passed)`);
      } else if (f.classification === "stable_fail") {
        lines.push(`  \x1b[31m✖\x1b[0m ${f.name} (${f.failCount}/${f.totalRuns} failed)`);
      }
    }
    lines.push(`\x1b[33m━━━━━━━━━━━━━━\x1b[0m\n`);
    console.log(lines.join("\n"));
  }
}

export default SolidusVitestReporter;
