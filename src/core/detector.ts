import type { AnalysisReport, FlakeClassification, FlakeReport, TestResult, TestRun, SolidusConfig } from "./types.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class FlakeDetector {
  constructor(private config: SolidusConfig) {}

  /**
   * Analyze test runs and return report.
   * @param runs - The test runs to analyze
   * @param quarantinedKeys - Optional set of "file::name" keys already quarantined
   */
  analyze(runs: TestRun[], quarantinedKeys?: Set<string>): AnalysisReport {
    if (runs.length === 0) {
      return {
        runId: "empty",
        total: 0, stable: 0, flaky: 0, broken: 0,
        quarantined: 0, insufficientData: 0,
        flakes: [],
      };
    }

    // Build unified map: key = `${file}::${name}`
    const testMap = new Map<string, {
      file: string;
      name: string;
      statuses: TestResult[];
    }>();

    for (const run of runs) {
      const seenInRun = new Set<string>();
      for (const r of run.results) {
        if (!r.name || !r.file || typeof r.status !== "string") continue;
        if (r.status !== "pass" && r.status !== "fail" && r.status !== "skip") continue;

        const key = `${r.file}::${r.name}`;
        // Dedup within one run (last status wins)
        if (seenInRun.has(key)) {
          const existing = testMap.get(key);
          if (existing) {
            existing.statuses[existing.statuses.length - 1] = r;
          }
          continue;
        }
        seenInRun.add(key);

        if (!testMap.has(key)) {
          testMap.set(key, { file: r.file, name: r.name, statuses: [] });
        }
        testMap.get(key)!.statuses.push(r);
      }
    }

    const flakes: FlakeReport[] = [];

    for (const [, data] of testMap) {
      const relevant = data.statuses.filter(s => s.status === "pass" || s.status === "fail");
      const passCount = relevant.filter(s => s.status === "pass").length;
      const failCount = relevant.filter(s => s.status === "fail").length;
      // Skip tests with only "skip" results
      if (relevant.length === 0) continue;
      const passRate = passCount / relevant.length;
      const displayedTotal = relevant.length;
      const lastStatus = data.statuses[data.statuses.length - 1]?.status ?? "skip";
      const classification = this.classify(relevant.length, passRate);

      const isQuarantined = quarantinedKeys?.has(`${data.file}::${data.name}`) ?? false;
      flakes.push({
        name: data.name,
        file: data.file,
        totalRuns: displayedTotal,
        passCount,
        failCount,
        passRate: round2(passRate),
        classification,
        lastStatus,
        quarantined: isQuarantined,
      });
    }

    // Sort: flaky first, then by pass rate ascending
    flakes.sort((a, b) => {
      const order = (c: string): number =>
        c === "flaky" ? 0 : c === "stable_fail" ? 1 : c === "insufficient_data" ? 2 : 3;
      const diff = order(a.classification) - order(b.classification);
      if (diff !== 0) return diff;
      return a.passRate - b.passRate;
    });

    const flaky = flakes.filter(f => f.classification === "flaky");
    const stable = flakes.filter(f => f.classification === "stable_pass");
    const broken = flakes.filter(f => f.classification === "stable_fail");
    const insufficient = flakes.filter(f => f.classification === "insufficient_data");

    // Auto-quarantine new flaky tests (not already quarantined)
    if (this.config.autoQuarantine) {
      for (const f of flaky) {
        const key = `${f.file}::${f.name}`;
        if (!quarantinedKeys?.has(key)) {
          f.quarantined = true;
        }
      }
    }

    // Always mark pre-quarantined tests in report
    if (quarantinedKeys) {
      for (const f of flakes) {
        if (quarantinedKeys.has(`${f.file}::${f.name}`)) {
          f.quarantined = true;
        }
      }
    }

    return {
      runId: runs[0]?.id ?? "unknown",
      total: flakes.length,
      stable: stable.length,
      flaky: flaky.length,
      broken: broken.length,
      quarantined: flaky.filter(f => f.quarantined).length,
      insufficientData: insufficient.length,
      flakes,
    };
  }

  private classify(totalRuns: number, passRate: number): FlakeClassification {
    if (totalRuns < this.config.minRuns) return "insufficient_data";
    if (passRate >= this.config.flakyThresholdHigh) return "stable_pass";
    if (passRate <= this.config.flakyThresholdLow) return "stable_fail";
    return "flaky";
  }
}
