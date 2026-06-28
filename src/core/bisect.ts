/**
 * Git-bisect integration for solidus.
 *
 * Pinpoints the commit range where a test first became flaky by
 * cross-referencing test history with git commit SHAs stored in TestRun.
 * Works purely from history data (no git commands needed by default).
 * Optionally outputs a `git bisect` command for automated debugging.
 */

import type { SolidusConfig, TestRun } from "./types.js";

export interface BisectResult {
  /** The test that was investigated */
  testName: string;
  testFile: string;
  /** Confidence score 0-1 (higher = more data points to support the finding) */
  confidence: number;
  /** The transition point */
  transition: {
    /** Run ID where the test last appeared stable */
    lastStableRunId?: string;
    /** Commit where the test last appeared stable */
    lastStableCommit?: string;
    /** Run ID where the test first appeared flaky */
    firstFlakyRunId?: string;
    /** Commit where the test first appeared flaky */
    firstFlakyCommit?: string;
    /** Whether the test was newly introduced (no stable period) */
    isNewTest: boolean;
  };
  /** History summary */
  history: {
    totalRuns: number;
    passCount: number;
    failCount: number;
    passRate: number;
    firstSeenRunId?: string;
    firstSeenTimestamp?: string;
  };
  /** Suggested git bisect command */
  suggestedBisect?: string;
}

export class BisectAnalyzer {
  constructor(private config: SolidusConfig) {}

  /**
   * Find when a test became flaky by scanning history chronologically.
   */
  analyze(testName: string, runs: TestRun[], testFile?: string, _quarantinedKeys?: Set<string>): BisectResult {
    // Filter runs that contain the test
    const relevantRuns = runs.filter(r =>
      r.results.some(res =>
        res.name === testName && (!testFile || res.file === testFile)
      )
    );

    if (relevantRuns.length === 0) {
      throw new Error(
        `Test "${testName}"${testFile ? ` in "${testFile}"` : ""} not found in history`
      );
    }

    // Sort chronologically (oldest first)
    const sorted = [...relevantRuns].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Get the specific result for this test in each run
    interface RunSnapshot {
      run: TestRun;
      result: { name: string; file: string; status: "pass" | "fail" | "skip"; durationMs: number; error?: string } | undefined;
    }

    const snapshots: RunSnapshot[] = sorted.map(run => ({
      run,
      result: run.results.find(r =>
        r.name === testName && (!testFile || r.file === testFile)
      ),
    }));

    // Compute pass/fail history
    const statuses = snapshots.map(s => s.result?.status ?? "skip").filter(st => st === "pass" || st === "fail");
    const passCount = statuses.filter(s => s === "pass").length;
    const failCount = statuses.filter(s => s === "fail").length;
    const totalRuns = passCount + failCount;
    const passRate = totalRuns > 0 ? passCount / totalRuns : 0;

    // Find transition point: last consecutive stable run → first flaky run
    // "Stable" = all-pass in that run
    // "Flaky" = any fail in that run
    let transitionIdx = -1;
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1]?.result;
      const curr = snapshots[i]?.result;
      if (!prev || !curr) continue;
      if (prev.status === "pass" && curr.status === "fail") {
        transitionIdx = i;
        break;
      }
    }

    const isNewTest = snapshots.every(s => s.result?.status === "fail");

    const result: BisectResult = {
      testName,
      testFile: testFile ?? snapshots[0]?.result?.file ?? "",
      confidence: Math.min(1, totalRuns / this.config.minRuns),
      transition: {
        isNewTest,
      },
      history: {
        totalRuns,
        passCount,
        failCount,
        passRate: Math.round(passRate * 100) / 100,
        firstSeenRunId: snapshots[0]?.run.id,
        firstSeenTimestamp: snapshots[0]?.run.timestamp,
      },
    };

    if (transitionIdx > 0 && !isNewTest) {
      const prevSnapshot = snapshots[transitionIdx - 1]!;
      const currSnapshot = snapshots[transitionIdx]!;
      result.transition.lastStableRunId = prevSnapshot.run.id;
      result.transition.lastStableCommit = prevSnapshot.run.commit;
      result.transition.firstFlakyRunId = currSnapshot.run.id;
      result.transition.firstFlakyCommit = currSnapshot.run.commit;

      // Generate suggested bisect command
      if (prevSnapshot.run.commit && currSnapshot.run.commit) {
        result.suggestedBisect =
          `# Suspect commits: ${prevSnapshot.run.commit}..${currSnapshot.run.commit}\n` +
          `git bisect start --first-parent\n` +
          `git bisect good ${prevSnapshot.run.commit}\n` +
          `git bisect bad ${currSnapshot.run.commit}\n` +
          `# Then run: npm test -- --filter "${testName}" && git bisect good || git bisect bad\n` +
          `# Or: node -e "const t=require('./test-setup');t.run('${testName}').then(r=>process.exit(r.pass?0:1))"`;
      }
    }

    return result;
  }

  /** Render bisect result as human-readable text */
  toText(result: BisectResult): string {
    const lines: string[] = [];
    lines.push(`solidus bisect`);
    lines.push(`  Test: ${result.testName}`);
    if (result.testFile) lines.push(`  File: ${result.testFile}`);
    lines.push(`  History: ${result.history.passCount}/${result.history.totalRuns} passed (${Math.round(result.history.passRate * 100)}%)`);
    lines.push(`  Confidence: ${Math.round(result.confidence * 100)}%`);
    lines.push(`  First seen: ${result.history.firstSeenTimestamp ?? "unknown"} (${result.history.firstSeenRunId ?? "?"})`);
    lines.push("");

    if (result.transition.isNewTest) {
      lines.push("  🆕 This test has never passed consistently since first recorded.");
      lines.push("     It may be a newly added flaky test or inherently unstable.");
    } else if (result.transition.lastStableCommit && result.transition.firstFlakyCommit) {
      lines.push("  🔍 Transition found:");
      lines.push(`     Last known good commit: ${result.transition.lastStableCommit}`);
      lines.push(`     First known bad commit: ${result.transition.firstFlakyCommit}`);
      if (result.suggestedBisect) {
        lines.push("");
        lines.push("  Suggested git bisect:");
        lines.push(result.suggestedBisect);
      }
    } else {
      lines.push("  📊 No clear transition point (commits not recorded in history).");
      lines.push("     Enable commit tracking to get bisect suggestions.");
    }
    lines.push("");

    return lines.join("\n");
  }
}
