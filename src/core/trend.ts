/**
 * Trend analysis for solidus.
 *
 * Computes per-window metrics over history to show how flakiness evolves.
 * Each data point slides the analysis window across run history.
 * Output options: ASCII timeline, JSON, CSV.
 */

import type { SolidusConfig, TestRun } from "./types.js";
import { FlakeDetector } from "./detector.js";

export interface TrendDataPoint {
  /** Run ID at the window end */
  runId: string;
  /** Timestamp at the window end */
  timestamp: string;
  /** Total tests in this window */
  total: number;
  /** Stable passing count */
  stable: number;
  /** Flaky count */
  flaky: number;
  /** Broken (stable_fail) count */
  broken: number;
  /** Insufficient data count */
  insufficientData: number;
  /** Quarantined count */
  quarantined: number;
}

export interface TrendReport {
  /** All data points */
  points: TrendDataPoint[];
  /** Summary statistics */
  summary: {
    totalRuns: number;
    dataPoints: number;
    firstTimestamp: string;
    lastTimestamp: string;
    currentFlaky: number;
    maxFlaky: number;
    flakyTrend: "increasing" | "decreasing" | "stable" | "insufficient";
  };
}

export class TrendAnalyzer {
  private config: SolidusConfig;
  private detector: FlakeDetector;

  constructor(config: SolidusConfig) {
    this.config = config;
    this.detector = new FlakeDetector(config);
  }

  /**
   * Compute trend report from history.
   * Slides window across runs to produce a data point per position.
   */
  analyze(runs: TestRun[], quarantinedKeys?: Set<string>): TrendReport {
    const points: TrendDataPoint[] = [];

    // Need at least 2 runs to detect a trend
    if (runs.length < 2) {
      return {
        points: [],
        summary: {
          totalRuns: runs.length,
          dataPoints: 0,
          firstTimestamp: runs[0]?.timestamp ?? "",
          lastTimestamp: runs[runs.length - 1]?.timestamp ?? "",
          currentFlaky: 0,
          maxFlaky: 0,
          flakyTrend: "insufficient",
        },
      };
    }

    // Slide window across runs
    // First point uses earliest runs; last point uses latest runs
    const minRuns = Math.max(this.config.minRuns, 2);
    const windowStep = Math.max(1, Math.floor(runs.length / 20)); // ~20 data points max

    for (let i = minRuns; i <= runs.length; i += windowStep) {
      const windowRuns = runs.slice(0, i);
      const result = this.detector.analyze(windowRuns, quarantinedKeys);
      points.push({
        runId: windowRuns[windowRuns.length - 1]?.id ?? "unknown",
        timestamp: windowRuns[windowRuns.length - 1]?.timestamp ?? "",
        total: result.total,
        stable: result.stable,
        flaky: result.flaky,
        broken: result.broken,
        insufficientData: result.insufficientData,
        quarantined: result.quarantined,
      });
    }

    // Add final point at exact end if we didn't just add it
    if (points.length === 0 || points[points.length - 1]!.runId !== runs[runs.length - 1]?.id) {
      const finalResult = this.detector.analyze(runs, quarantinedKeys);
      points.push({
        runId: runs[runs.length - 1]?.id ?? "unknown",
        timestamp: runs[runs.length - 1]?.timestamp ?? "",
        total: finalResult.total,
        stable: finalResult.stable,
        flaky: finalResult.flaky,
        broken: finalResult.broken,
        insufficientData: finalResult.insufficientData,
        quarantined: finalResult.quarantined,
      });
    }

    // Compute summary
    const flakyValues = points.map(p => p.flaky);
    const maxFlaky = Math.max(...flakyValues, 0);
    const currentFlaky = points[points.length - 1]?.flaky ?? 0;

    let flakyTrend: "increasing" | "decreasing" | "stable" | "insufficient" = "insufficient";
    if (points.length >= 3) {
      const half = Math.floor(points.length / 2);
      const firstHalfAvg = flakyValues.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const secondHalfAvg = flakyValues.slice(-half).reduce((a, b) => a + b, 0) / half;
      const diff = secondHalfAvg - firstHalfAvg;
      const threshold = Math.max(1, firstHalfAvg * 0.2); // 20% change or 1, whichever higher
      if (diff > threshold) flakyTrend = "increasing";
      else if (diff < -threshold) flakyTrend = "decreasing";
      else flakyTrend = "stable";
    }

    return {
      points,
      summary: {
        totalRuns: runs.length,
        dataPoints: points.length,
        firstTimestamp: points[0]?.timestamp ?? "",
        lastTimestamp: points[points.length - 1]?.timestamp ?? "",
        currentFlaky,
        maxFlaky,
        flakyTrend,
      },
    };
  }

  /** Render ASCII trend chart */
  toAscii(report: TrendReport): string {
    const { points, summary } = report;
    if (points.length === 0) return "Insufficient data to show trend. Need at least 2 runs.";

    const lines: string[] = [];
    lines.push("solidus trend report");
    lines.push(`  Runs: ${summary.totalRuns} · Data points: ${summary.dataPoints}`);
    lines.push(`  Period: ${summary.firstTimestamp?.slice(0, 10) ?? "?"} → ${summary.lastTimestamp?.slice(0, 10) ?? "?"}`);

    // Flaky trend indicator
    const trendIcon = summary.flakyTrend === "increasing" ? "📈" :
      summary.flakyTrend === "decreasing" ? "📉" : "➡️";
    lines.push(`  Current flaky: ${summary.currentFlaky} · Max: ${summary.maxFlaky} ${trendIcon} ${summary.flakyTrend}`);
    lines.push("");

    // ASCII bar chart for flaky count over time
    const maxFlaky = Math.max(summary.maxFlaky, 1);
    const barWidth = Math.min(maxFlaky, 40);

    lines.push("  Flaky tests over time:");
    for (const p of points) {
      const barLen = Math.max(1, Math.round((p.flaky / maxFlaky) * barWidth));
      const bar = "█".repeat(Math.min(barLen, 40));
      const label = p.timestamp?.slice(5, 16) ?? "?";
      const value = String(p.flaky).padStart(3);
      lines.push(`  ${label} ${value} ${bar}`);
    }
    lines.push("");

    // Summary line
    lines.push(`  ${summary.flakyTrend === "increasing" ? "⚠️" : "✅"} Flakiness is ${summary.flakyTrend}`);
    if (summary.flakyTrend === "increasing") {
      lines.push("  Consider reviewing recently merged code or enabling auto-quarantine.");
    }
    lines.push("");

    return lines.join("\n");
  }
}
