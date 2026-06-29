import { appendFileSync } from "node:fs";
import type { AnalysisReport } from "../core/types.js";
import { Logger } from "../core/logger.js";

/**
 * GitHub Actions annotation output.
 *
 * Generates workflow commands:
 *  - ::warning:: annotations on flaky test source files
 *  - Step outputs for downstream jobs
 *  - Step summary markdown
 */
export function annotateGitHub(
  report: AnalysisReport,
  log: Logger,
  options?: { failOnFlaky?: boolean },
): void {
  const outFile = process.env.GITHUB_OUTPUT;
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;

  // Set step outputs
  if (outFile) {
    writeOutput(outFile, "flaky-count", String(report.flaky));
    writeOutput(outFile, "stable-count", String(report.stable));
    writeOutput(outFile, "broken-count", String(report.broken));
    writeOutput(outFile, "quarantined-count", String(report.quarantined));
    writeOutput(outFile, "total", String(report.total));

    // JSON payload for matrix jobs
    const json = JSON.stringify({ flaky: report.flaky, stable: report.stable });
    writeOutput(outFile, "report", json);
  }

  // Annotate flaky tests with source file warnings
  for (const f of report.flakes) {
    const safeName = sanitizeAnnotation(f.name);
    console.log(
      `::warning file=${f.file},title=solidus::${safeName} flaky (${f.passCount}/${f.totalRuns} passed)`,
    );
  }

  // Annotate broken tests (stable failures)
  for (const f of report.flakes) {
    if (f.classification !== "stable_fail") continue;
    const safeName = sanitizeAnnotation(f.name);
    console.log(
      `::error file=${f.file},title=solidus::${safeName} consistently failing (${f.failCount}/${f.totalRuns} failed)`,
    );
  }

  // Step summary
  if (summaryFile) {
    appendFileSync(summaryFile, generateSummaryMD(report));
  }

  log.info(`GitHub annotations: ${report.flaky} flaky, ${report.stable} stable, ${report.broken} broken`);

  if (options?.failOnFlaky && report.flaky > 0) {
    log.error(`${report.flaky} flaky tests found — fail-on-flaky enabled`);
    console.log(`::error::solidus: ${report.flaky} flaky tests found`);
    process.exitCode = 1;
  }
}

function writeOutput(file: string, name: string, value: string): void {
  // GitHub output supports multiline via heredoc-style delimiters
  appendFileSync(file, `${name}=${value}\n`, "utf-8");
}

/** Remove newlines and special chars from annotation titles */
function sanitizeAnnotation(s: string): string {
  return s.replace(/[<>"'&\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

function generateSummaryMD(report: AnalysisReport): string {
  const rows: string[] = [];
  rows.push(`## solidus flake report\n`);
  rows.push(`| Metric | Count |`);
  rows.push(`|--------|------:|`);
  rows.push(`| Total tests | ${report.total} |`);
  rows.push(`| ✅ Stable passing | ${report.stable} |`);
  rows.push(`| ⚠️ Flaky | ${report.flaky} |`);
  rows.push(`| ❌ Stable failing | ${report.broken} |`);
  rows.push(`| 🔒 Quarantined | ${report.quarantined} |`);
  rows.push(`| 📊 Insufficient data | ${report.insufficientData} |`);
  rows.push(``);

  const problematic = report.flakes.filter(f =>
    f.classification === "flaky" || f.classification === "stable_fail"
  );
  if (problematic.length > 0) {
    rows.push(`### Tests needing attention\n`);
    rows.push(`| Test | File | Pass rate | Status |`);
    rows.push(`|------|------|----------:|:------:|`);
    for (const f of problematic) {
      const icon = f.classification === "stable_fail" ? "❌" : "⚠️";
      const q = f.quarantined ? " 🔒" : "";
      rows.push(`| ${icon} ${f.name}${q} | \`${f.file}\` | ${f.passCount}/${f.totalRuns} | ${f.classification} |`);
    }
  }
  rows.push(``);
  // Footer with machine-readable JSON (hidden in HTML comment)
  rows.push(`<!-- solidus:${JSON.stringify({ flaky: report.flaky, total: report.total })} -->`);
  return rows.join("\n");
}
