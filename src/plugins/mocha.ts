/**
 * Mocha reporter plugin.
 *
 * Auto-collects test results via Mocha's event-based Runner API,
 * stores in solidus history, and prints flake summary.
 *
 * Usage via .mocharc.js / mocha.config.js:
 *   import SolidusMochaReporter from 'solidus/dist/plugins/mocha.js';
 *   export default {
 *     reporter: SolidusMochaReporter,
 *     reporterOptions: { dbPath: '.solidus/history.db' },
 *   };
 *
 * Or on the CLI:
 *   mocha --reporter solidus/dist/plugins/mocha.js --reporter-options dbPath=.solidus/history.db
 *
 * Pure ESM. Works with Mocha 10.x+.
 * Requires mocha as a peer dependency (not installed by solidus).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TestResult, TestRun, SolidusConfig, FlakeReport } from "../core/types.js";
import { DEFAULTS } from "../core/types.js";
import { HistoryStore } from "../core/history.js";
import { FlakeDetector } from "../core/detector.js";
import { Logger } from "../core/logger.js";

// Mocha events (string literals for compatibility across versions)
const EVENT_TEST_PASS = "pass";
const EVENT_TEST_FAIL = "fail";
const EVENT_TEST_PENDING = "pending";
const EVENT_RUN_END = "end";

interface MochaReporterOptions {
  dbPath?: string;
  autoQuarantine?: boolean;
  logLevel?: string;
}

interface MochaSuite {
  title: string;
  file?: string;
  parent?: MochaSuite;
  root?: boolean;
}

interface MochaTest {
  title: string;
  fullTitle(): string;
  file?: string;
  duration?: number;
  state?: "passed" | "failed";
  err?: { message?: string; stack?: string };
  parent?: MochaSuite;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MochaListener = (...args: any[]) => void;

interface MochaRunner {
  on(event: string, listener: MochaListener): void;
}

/**
 * Extract source file from a Mocha test by walking up the suite chain.
 */
function getTestFile(test: MochaTest): string {
  if (test.file) return test.file;
  let parent = test.parent;
  while (parent) {
    if (parent.file) return parent.file;
    parent = parent.parent;
  }
  return "unknown";
}

class SolidusMochaReporter {
  private results: TestResult[] = [];
  private startTime = Date.now();
  private config: SolidusConfig;
  private store: HistoryStore;
  private log: Logger;

  constructor(runner: MochaRunner, options: { reporterOptions?: MochaReporterOptions } = {}) {
    const opts = options.reporterOptions ?? {};
    this.config = {
      ...DEFAULTS,
      dbPath: opts.dbPath ?? DEFAULTS.dbPath,
      autoQuarantine: opts.autoQuarantine ?? DEFAULTS.autoQuarantine,
      logLevel: (opts.logLevel ?? "info") as SolidusConfig["logLevel"],
    };
    this.log = new Logger(this.config.logLevel, "solidus:mocha");
    this.store = new HistoryStore(this.config, this.log);

    // Wire up Mocha events
    runner.on(EVENT_TEST_PASS, (test: MochaTest) => {
      this.results.push({
        name: test.fullTitle() || test.title || "unnamed test",
        file: getTestFile(test),
        status: "pass",
        durationMs: test.duration ?? 0,
      });
    });

    runner.on(EVENT_TEST_FAIL, (test: MochaTest, err: Error) => {
      this.results.push({
        name: test.fullTitle() || test.title || "unnamed test",
        file: getTestFile(test),
        status: "fail",
        durationMs: test.duration ?? 0,
        error: (err?.message || String(err))?.slice(0, 1000) ?? undefined,
      });
    });

    runner.on(EVENT_TEST_PENDING, (test: MochaTest) => {
      this.results.push({
        name: test.fullTitle() || test.title || "unnamed test",
        file: getTestFile(test),
        status: "skip",
        durationMs: 0,
      });
    });

    runner.on(EVENT_RUN_END, () => {
      this.onRunComplete();
    });
  }

  private onRunComplete(): void {
    if (this.results.length === 0) {
      this.log.warn("No test results collected");
      return;
    }

    const run: TestRun = {
      id: `mocha_${this.startTime}_${Math.random().toString(36).slice(2, 8)}`,
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

export default SolidusMochaReporter;
