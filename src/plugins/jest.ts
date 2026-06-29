/**
 * Jest reporter plugin.
 *
 * Auto-collects test results on every run, stores in solidus history,
 * and prints flake summary at the end.
 *
 * Usage in jest.config.js / jest.config.mjs:
 *   reporters: [
 *     "default",
 *     ["solidus/dist/plugins/jest.js", { dbPath: ".solidus/history.db" }]
 *   ]
 *
 * Pure ESM compatible. Uses dynamic import for CJS interop.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TestResult, TestRun, SolidusConfig, FlakeReport } from "../core/types.js";
import { DEFAULTS } from "../core/types.js";
import { HistoryStore } from "../core/history.js";
import { FlakeDetector } from "../core/detector.js";
import { Logger } from "../core/logger.js";

interface JestReporterOptions {
  dbPath?: string;
  autoQuarantine?: boolean;
  logLevel?: string;
}

class SolidusJestReporter {
  private results: TestResult[] = [];
  private startTime = Date.now();
  private config: SolidusConfig;
  private store: HistoryStore;
  private log: Logger;

  constructor(_globalConfig: unknown, opts: JestReporterOptions) {
    this.config = {
      ...DEFAULTS,
      dbPath: opts.dbPath ?? DEFAULTS.dbPath,
      autoQuarantine: opts.autoQuarantine ?? DEFAULTS.autoQuarantine,
      logLevel: (opts.logLevel ?? "info") as SolidusConfig["logLevel"],
    };
    this.log = new Logger(this.config.logLevel, "solidus:jest");
    this.store = new HistoryStore(this.config, this.log);
  }

  onTestResult(_test: unknown, testResult: { testResults?: Array<{
    status?: string;
    title?: string;
    ancestorTitles?: string[];
    duration?: number;
    failureMessages?: string[];
  }>; testFilePath?: string }): void {
    const file = testResult.testFilePath ?? "unknown";

    for (const assertion of testResult.testResults ?? []) {
      const status = assertion.status === "passed" ? "pass" as const
        : assertion.status === "failed" ? "fail" as const
        : "skip" as const;

      const name = [...(assertion.ancestorTitles ?? []), assertion.title ?? "unnamed"]
        .filter(Boolean)
        .join(" > ");

      this.results.push({
        name: name || "unnamed test",
        file,
        status,
        durationMs: assertion.duration ?? 0,
        error: assertion.failureMessages?.join("\n") ?? undefined,
      });
    }
  }

  onRunComplete(): void {
    const run: TestRun = {
      id: `jest_${this.startTime}_${Math.random().toString(36).slice(2, 8)}`,
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

    // Write report
    const dir = dirname(this.config.dbPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/latest-report.json`, JSON.stringify(report, null, 2));

    // Print summary
    this.printSummary(report);
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

export default SolidusJestReporter;
