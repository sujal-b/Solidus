#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { FlakeDetector } from "./core/detector.js";
import { HistoryStore } from "./core/history.js";
import { TrendAnalyzer } from "./core/trend.js";
import { BisectAnalyzer } from "./core/bisect.js";
import { Logger } from "./core/logger.js";
import { loadConfig } from "./core/config.js";
import { annotateGitHub } from "./ci/github.js";
import { sendSlackWebhook } from "./ci/slack.js";
import { FileQuarantineStore } from "./quarantine.js";
import type { TestRun, SolidusConfig } from "./core/types.js";
import { validateTestRun } from "./core/types.js";
import { SolidusError, ValidationError } from "./core/errors.js";
import { parseJunitXml, parseJunitFile } from "./parsers/junit.js";

const program = new Command();

program
  .name("solidus")
  .description("Declarative flaky-test detection & quarantine. Solidus your CI again.")
  .version("0.1.0");

// ---- analyze ----
program
  .command("analyze")
  .description("Analyze test results for flakiness")
  .option("-i, --input <file>", "Input file (reads from stdin if omitted)")
  .option("--input-format <format>", "Input format: json (default) or junit", "json")
  .option("--db-path <path>", "History DB path")
  .option("--window <n>", "Number of recent runs to consider")
  .option("--min-runs <n>", "Minimum runs before classification")
  .option("--auto-quarantine", "Auto-quarantine flaky tests")
  .option("--no-auto-quarantine", "Disable auto-quarantine")
  .option("--log-level <level>", "Log level: silent|error|warn|info|debug")
  .option("--json", "Output as JSON")
  .option("--github", "Output GitHub Actions annotations")
  .option("--fail-on-flaky", "Exit 1 if flaky tests found")
  .action(async (opts) => {
    const log = new Logger("info", "solidus");

    try {
      const cliOverrides: Partial<SolidusConfig> = {};
      if (opts.dbPath) cliOverrides.dbPath = opts.dbPath;
      if (opts.window) cliOverrides.windowSize = parseInt(opts.window, 10);
      if (opts.minRuns) cliOverrides.minRuns = parseInt(opts.minRuns, 10);
      if (opts.autoQuarantine === true) cliOverrides.autoQuarantine = true;
      if (opts.autoQuarantine === false) cliOverrides.autoQuarantine = false;
      if (opts.logLevel) cliOverrides.logLevel = opts.logLevel;

      const config = loadConfig(cliOverrides);
      log.info(`Config loaded (window=${config.windowSize}, minRuns=${config.minRuns})`);

      // Read input
      const inputFormat = opts.inputFormat || "json";
      if (inputFormat !== "json" && inputFormat !== "junit") {
        throw new ValidationError(`Invalid input format: "${inputFormat}". Must be "json" or "junit"`);
      }
      let run: TestRun;

      if (inputFormat === "junit") {
        // JUnit XML input
        if (opts.input) {
          if (!existsSync(opts.input)) {
            throw new ValidationError(`Input file not found: ${opts.input}`);
          }
          log.info(`Parsing JUnit XML from ${opts.input}...`);
          run = parseJunitFile(opts.input);
        } else {
          log.info("Reading JUnit XML from stdin...");
          const input = await readStdin();
          if (!input || input.trim().length === 0) {
            throw new ValidationError("Empty input — no test data to analyze");
          }
          run = parseJunitXml(input);
        }
        log.info(`Parsed ${run.results.length} test(s) from JUnit XML`);
      } else {
        // Default: JSON input
        let input: string;
        if (opts.input) {
          if (!existsSync(opts.input)) {
            throw new ValidationError(`Input file not found: ${opts.input}`);
          }
          input = readFileSync(opts.input, "utf-8");
        } else {
          log.info("Reading test run from stdin...");
          input = await readStdin();
        }

        if (!input || input.trim().length === 0) {
          throw new ValidationError("Empty input — no test data to analyze");
        }

        try {
          run = JSON.parse(input) as TestRun;
        } catch (err) {
          throw new ValidationError("Invalid JSON input", err);
        }

        // Validate
        const errs = validateTestRun(run);
        if (errs.length > 0) {
          throw new ValidationError(`Invalid test run data:\n  ${errs.join("\n  ")}`);
        }
      }

      if (!run.results || run.results.length === 0) {
        log.warn("Test run has zero results (no tests executed?)");
      }

      // Save and analyze
      const store = new HistoryStore(config, log);
      store.saveRun(run);
      const recent = store.getRecentRuns(config.windowSize);

      // Load quarantine data
      const quarantine = new FileQuarantineStore(config.dbPath, log);
      const existingQuarantine = new Set(
        quarantine.load().map(e => `${e.file}::${e.name}`)
      );
      const detector = new FlakeDetector(config);
      const report = detector.analyze(recent, existingQuarantine);

      // Auto-quarantine new flaky tests
      if (config.autoQuarantine) {
        for (const f of report.flakes) {
          if (f.classification === "flaky" && !existingQuarantine.has(`${f.file}::${f.name}`)) {
            quarantine.add({
              name: f.name,
              file: f.file,
              reason: `Flaky (${f.passCount}/${f.totalRuns} passed, ${Math.round((1 - f.passRate) * 100)}% fail rate)`,
              quarantinedAt: run.timestamp,
              flakeCount: 1,
            });
            log.info(`Auto-quarantined: ${f.file}::${f.name}`);
          }
        }
      }

      // Send Slack webhook if configured
      try {
        sendSlackWebhook(report, config, log);
      } catch { /* Slack failure is non-fatal */ }

      // Persist latest report
      const reportDir = dirname(config.dbPath);
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, "latest-report.json"), JSON.stringify(report, null, 2));

      store.close();

      // Output
      if (opts.github) {
        annotateGitHub(report, log, { failOnFlaky: opts.failOnFlaky });
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        printSummary(report);
      }

      if (opts.failOnFlaky && !opts.github && report.flaky > 0) {
        log.error(`Exiting with error: ${report.flaky} flaky tests`);
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof SolidusError) {
        log.error(`${err.code}: ${err.message}`);
      } else {
        log.error(`Unexpected error: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

// ---- report ----
program
  .command("report")
  .description("Show latest flake report")
  .option("--db-path <path>", "History DB path", ".solidus/history.db")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const reportPath = join(dirname(opts.dbPath), "latest-report.json");
    if (!existsSync(reportPath)) {
      console.error("No report found. Run `solidus analyze` first.");
      process.exit(1);
    }
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        printSummary(report);
      }
    } catch (err) {
      const log = new Logger("error", "solidus");
      log.error(`Corrupted or missing report: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---- trend ----
program
  .command("trend")
  .description("Show flakiness trend over time")
  .option("--db-path <path>", "History DB path", ".solidus/history.db")
  .option("--window <n>", "Number of recent runs to consider")
  .option("--min-runs <n>", "Minimum runs before classification")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const cliOverrides: Partial<SolidusConfig> = {};
    if (opts.dbPath) cliOverrides.dbPath = opts.dbPath;
    if (opts.window) cliOverrides.windowSize = parseInt(opts.window, 10);
    if (opts.minRuns) cliOverrides.minRuns = parseInt(opts.minRuns, 10);
    const config = loadConfig(cliOverrides);
    const log = new Logger("silent");
    const store = new HistoryStore(config, log);
    const allRuns = store.getRecentRuns(1000); // get all
    store.close();

    const quarantine = new FileQuarantineStore(config.dbPath, log);
    const quarantinedKeys = new Set(quarantine.load().map(e => `${e.file}::${e.name}`));
    quarantine.close();

    const analyzer = new TrendAnalyzer(config);
    const report = analyzer.analyze(allRuns, quarantinedKeys);

    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      console.log(analyzer.toAscii(report));
    }
  });

// ---- bisect ----
program
  .command("bisect")
  .description("Find when a test became flaky")
  .argument("<test-name>", "Test name to investigate")
  .option("--file <file>", "Source file to narrow search")
  .option("--db-path <path>", "History DB path", ".solidus/history.db")
  .option("--json", "Output as JSON")
  .action((testName, opts) => {
    const config = loadConfig({ ...opts.dbPath ? { dbPath: opts.dbPath } : {} });
    const log = new Logger("info", "solidus");
    const store = new HistoryStore(config, log);
    const allRuns = store.getRecentRuns(1000);
    store.close();

    const analyzer = new BisectAnalyzer(config);
    try {
      const result = analyzer.analyze(testName, allRuns, opts.file);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        console.log(analyzer.toText(result));
      }
    } catch (err) {
      log.error((err as Error).message);
      process.exitCode = 1;
    }
  });

// ---- init ----
program
  .command("init")
  .description("Initialize .solidus directory")
  .action(() => {
    mkdirSync(".solidus", { recursive: true });
    console.log("Created .solidus/");

    const gitignorePath = ".gitignore";
    const entry = "\n# solidus\n.solidus/\n";
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      if (!content.includes(".solidus/")) {
        writeFileSync(gitignorePath, content + entry);
        console.log("Appended .solidus/ to .gitignore");
      }
    }
    console.log("Ready. Run `solidus analyze < results.json` to start.");
  });

// ---- status ----
program
  .command("status")
  .description("Show history stats")
  .option("--db-path <path>", "History DB path", ".solidus/history.db")
  .action((opts) => {
    const CONFIG = { ...loadConfig({}), dbPath: opts.dbPath };
    const log = new Logger("silent");
    const store = new HistoryStore(CONFIG, log);
    const count = store.runCount();
    const recent = store.getRecentRuns(1);
    store.close();

    console.log(`Runs stored: ${count}`);
    if (recent.length > 0) {
      console.log(`Latest run: ${recent[0]?.id} (${recent[0]?.results.length} tests, ${recent[0]?.timestamp})`);
    } else {
      console.log(`Latest run: (none)`);
    }
  });

// ---- clear ----
program
  .command("clear")
  .description("Delete all stored history")
  .option("--db-path <path>", "History DB path", ".solidus/history.db")
  .action((opts) => {
    const CONFIG = { ...loadConfig({}), dbPath: opts.dbPath };
    const log = new Logger("info", "solidus");
    const store = new HistoryStore(CONFIG, log);
    store.clear();
    store.close();
    log.info("History cleared");
  });

// ---- quarantine ----
const qCmd = program
  .command("quarantine")
  .description("Manage quarantined flaky tests")
  .option("--db-path <path>", "History DB path", ".solidus/history.db")
  .option("--json", "JSON output");

qCmd
  .command("list")
  .description("List quarantined tests")
  .action((_opts, cmd) => {
    const parentOpts = cmd.parent.opts();
    const CONFIG = { ...loadConfig({}), dbPath: parentOpts.dbPath };
    const log = new Logger("silent");
    const qStore = new FileQuarantineStore(CONFIG.dbPath, log);
    if (parentOpts.json) {
      process.stdout.write(JSON.stringify(qStore.load(), null, 2) + "\n");
    } else {
      console.log(qStore.toListing());
    }
    qStore.close();
  });

qCmd
  .command("add <file> <name>")
  .description("Add a test to quarantine")
  .option("--reason <reason>", "Quarantine reason", "Manually quarantined")
  .action((file, name, opts, cmd) => {
    const parentOpts = cmd.parent.opts();
    const CONFIG = { ...loadConfig({}), dbPath: parentOpts.dbPath };
    const log = new Logger("info", "solidus");
    const qStore = new FileQuarantineStore(CONFIG.dbPath, log);
    const added = qStore.add({
      name,
      file,
      reason: opts.reason,
      quarantinedAt: new Date().toISOString(),
      flakeCount: 1,
    });
    qStore.close();
    log.info(added ? `Added: ${file} :: ${name}` : `Updated: ${file} :: ${name}`);
  });

qCmd
  .command("remove <file> <name>")
  .description("Remove a test from quarantine")
  .action((file, name, _opts, cmd) => {
    const parentOpts = cmd.parent.opts();
    const CONFIG = { ...loadConfig({}), dbPath: parentOpts.dbPath };
    const log = new Logger("info", "solidus");
    const qStore = new FileQuarantineStore(CONFIG.dbPath, log);
    if (qStore.remove(file, name)) {
      log.info(`Removed: ${file} :: ${name}`);
    } else {
      log.warn(`Not found: ${file} :: ${name}`);
    }
    qStore.close();
  });

qCmd
  .command("generate-ignore")
  .description("Generate config snippet to skip quarantined tests")
  .option("--format <format>", "jest|vitest|text", "text")
  .action((opts, cmd) => {
    const parentOpts = cmd.parent.opts();
    const CONFIG = { ...loadConfig({}), dbPath: parentOpts.dbPath };
    const log = new Logger("silent");
    const qStore = new FileQuarantineStore(CONFIG.dbPath, log);
    if (opts.format === "jest") {
      console.log(qStore.toJestPattern());
    } else if (opts.format === "vitest") {
      console.log(qStore.toVitestPattern());
    } else {
      console.log(qStore.toListing());
    }
    qStore.close();
  });

qCmd
  .command("clear")
  .description("Remove all quarantined tests")
  .action((_opts, cmd) => {
    const parentOpts = cmd.parent.opts();
    const CONFIG = { ...loadConfig({}), dbPath: parentOpts.dbPath };
    const log = new Logger("info", "solidus");
    const qStore = new FileQuarantineStore(CONFIG.dbPath, log);
    const count = qStore.load().length;
    qStore.clear();
    qStore.close();
    log.info(`Cleared ${count} quarantine entries`);
  });

program.parse(process.argv);

// ---- Helpers ----

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => lines.push(l));
    rl.on("close", () => resolve(lines.join("\n")));
    rl.on("error", reject);
  });
}

function printSummary(report: {
  total: number;
  stable: number;
  flaky: number;
  broken: number;
  quarantined: number;
  insufficientData: number;
  flakes: Array<{ name: string; classification: string; passCount: number; totalRuns: number; lastStatus: string }>;
}): void {
  const { green, yellow, red, bold, reset } = colors();
  console.log(`\n${bold}solidus flake report${reset}`);
  const parts: string[] = [];
  if (report.stable > 0) parts.push(`${green}${report.stable} stable${reset}`);
  if (report.flaky > 0) parts.push(`${yellow}${report.flaky} flaky${reset}`);
  if (report.broken > 0) parts.push(`${red}${report.broken} broken${reset}`);
  if (report.quarantined > 0) parts.push(`🔒 ${report.quarantined} quarantined`);
  if (report.insufficientData > 0) parts.push(`📊 ${report.insufficientData} new`);
  console.log(`  ${parts.join("  ")}`);
  console.log(`  Total: ${report.total} tests across all runs`);

  const problematic = report.flakes.filter(f =>
    f.classification === "flaky" || f.classification === "stable_fail"
  );
  if (problematic.length > 0) {
    console.log(`\n  ${bold}Tests needing attention:${reset}`);
    for (const f of problematic) {
      const icon = f.lastStatus === "pass" ? "⚠️" : "❌";
      console.log(`    ${icon} ${f.name} (${f.passCount}/${f.totalRuns} passed)`);
    }
  }
  console.log();
}

function colors() {
  const noColor = !!process.env.NO_COLOR || !process.stdout.isTTY;
  return {
    green:  noColor ? "" : "\x1b[32m",
    yellow: noColor ? "" : "\x1b[33m",
    red:    noColor ? "" : "\x1b[31m",
    bold:   noColor ? "" : "\x1b[1m",
    reset:  noColor ? "" : "\x1b[0m",
  };
}
