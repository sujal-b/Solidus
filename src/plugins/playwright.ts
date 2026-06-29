/**
 * Playwright test reporter plugin.
 *
 * Collects E2E test results from Playwright runs, stores in solidus history,
 * and prints flake summary.
 *
 * Usage in playwright.config.ts:
 *   export default {
 *     reporter: [
 *       ['html'],
 *       ['solidus/dist/plugins/playwright.js', { dbPath: '.solidus/history.db' }],
 *     ],
 *   };
 *
 * Pure ESM. Works with Playwright 1.40+.
 * Requires @playwright/test as a peer dependency (not installed by solidus).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TestResult, TestRun, SolidusConfig, FlakeReport } from "../core/types.js";
import { DEFAULTS } from "../core/types.js";
import { HistoryStore } from "../core/history.js";
import { FlakeDetector } from "../core/detector.js";
import { Logger } from "../core/logger.js";

interface PlaywrightReporterOptions {
  dbPath?: string;
  autoQuarantine?: boolean;
  logLevel?: string;
}

interface PlaywrightTestCase {
  title: string;
  parent: PlaywrightSuite | null;
  location?: { file: string };
}

interface PlaywrightSuite {
  title: string;
  parent?: PlaywrightSuite | null;
  location?: { file: string };
}

interface PlaywrightTestResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  error?: { message?: string; stack?: string };
}

/**
 * Get the fully qualified test name by walking up the parent chain.
 */
function fullTestName(test: PlaywrightTestCase): string {
  const parts: string[] = [test.title];
  let parent = test.parent;
  while (parent && parent.title) {
    parts.unshift(parent.title);
    parent = parent.parent ?? null;
  }
  return parts.join(" > ");
}

/**
 * Get the source file from the test or its parent chain.
 */
function testFile(test: PlaywrightTestCase): string {
  if (test.location?.file) return test.location.file;
  let parent = test.parent;
  while (parent) {
    if (parent.location?.file) return parent.location.file;
    parent = parent.parent ?? null;
  }
  return "unknown";
}

class SolidusPlaywrightReporter {
  private results: TestResult[] = [];
  private startTime = Date.now();
  private config: SolidusConfig;
  private store: HistoryStore;
  private log: Logger;

  constructor(opts: PlaywrightReporterOptions = {}) {
    this.config = {
      ...DEFAULTS,
      dbPath: opts.dbPath ?? DEFAULTS.dbPath,
      autoQuarantine: opts.autoQuarantine ?? DEFAULTS.autoQuarantine,
      logLevel: (opts.logLevel ?? "info") as SolidusConfig["logLevel"],
    };
    this.log = new Logger(this.config.logLevel, "solidus:playwright");
    this.store = new HistoryStore(this.config, this.log);
  }

  /**
   * Called by Playwright when a single test ends.
   */
  onTestEnd(test: PlaywrightTestCase, result: PlaywrightTestResult): void {
    const status = result.status === "passed" ? "pass" as const
      : result.status === "failed" || result.status === "timedOut" ? "fail" as const
      : "skip" as const;

    const error = result.error
      ? (result.error.message ?? result.error.stack)
      : undefined;

    this.results.push({
      name: fullTestName(test),
      file: testFile(test),
      status,
      durationMs: result.duration ?? 0,
      error: error?.slice(0, 1000) ?? undefined,
    });
  }

  /**
   * Called by Playwright when all tests in the run complete.
   */
  onEnd(): void {
    if (this.results.length === 0) {
      this.log.warn("No test results collected");
      return;
    }

    const run: TestRun = {
      id: `pw_${this.startTime}_${Math.random().toString(36).slice(2, 8)}`,
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

export default SolidusPlaywrightReporter;
