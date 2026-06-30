import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We test the compiled JS since TS import needs extra setup
const { FlakeDetector } = await import("../dist/core/detector.js");
const { DEFAULTS } = await import("../dist/core/types.js");

const BASE_CONFIG = { ...DEFAULTS, windowSize: 10, minRuns: 2 };

function makeRun(id, results) {
  return {
    id: `run_${id}`,
    timestamp: new Date().toISOString(),
    results,
  };
}

function result(name, status, file = "src/test.ts") {
  return { name, file, status, durationMs: 10 };
}

await describe("FlakeDetector", async () => {

  await it("empty runs → empty report", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const r = d.analyze([]);
    assert.equal(r.total, 0);
    assert.equal(r.flaky, 0);
    assert.equal(r.runId, "empty");
  });

  await it("all pass → all stable", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRun(i, [result("A", "pass"), result("B", "pass")])
    );
    const r = d.analyze(runs);
    assert.equal(r.total, 2);
    assert.equal(r.stable, 2);
    assert.equal(r.flaky, 0);
  });

  await it("all fail → stable_fail", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRun(i, [result("A", "fail")])
    );
    const r = d.analyze(runs);
    assert.equal(r.total, 1);
    assert.equal(r.stable, 0);
    assert.equal(r.broken, 1);
  });

  await it("50% pass → flaky", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 6 }, (_, i) =>
      makeRun(i, [result("A", i % 2 === 0 ? "pass" : "fail")])
    );
    const r = d.analyze(runs);
    assert.equal(r.flaky, 1);
    assert.equal(r.flakes[0].classification, "flaky");
    assert.equal(r.flakes[0].passRate, 0.5);
  });

  await it("insufficient data when < minRuns", () => {
    const d = new FlakeDetector({ ...BASE_CONFIG, minRuns: 5 });
    const runs = Array.from({ length: 2 }, (_, i) =>
      makeRun(i, [result("A", "pass")])
    );
    const r = d.analyze(runs);
    assert.equal(r.insufficientData, 1);
    assert.equal(r.flakes[0].classification, "insufficient_data");
  });

  await it("dedup within same run (last status wins)", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = [
      makeRun(1, [
        result("A", "pass"),
        result("A", "fail"),  // duplicate: last wins
      ]),
      makeRun(2, [result("A", "pass")]),
      makeRun(3, [result("A", "pass")]),
    ];
    const r = d.analyze(runs);
    // A should have 3 results (one per run), passCount = 2 (run1:fail, run2:pass, run3:pass)
    const flake = r.flakes.find(f => f.name === "A");
    assert.equal(flake.totalRuns, 3);
    assert.equal(flake.passCount, 2);
  });

  await it("auto-quarantine marks flaky tests", () => {
    const d = new FlakeDetector({ ...BASE_CONFIG, autoQuarantine: true });
    const runs = Array.from({ length: 6 }, (_, i) =>
      makeRun(i, [result("A", i % 2 === 0 ? "pass" : "fail"), result("B", "pass")])
    );
    const r = d.analyze(runs);
    assert.equal(r.quarantined, 1);
    assert(r.flakes.find(f => f.classification === "flaky")?.quarantined);
  });

  await it("skips malformed results gracefully", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = [
      makeRun(1, [
        result("A", "pass"),
        { name: "", file: "", status: "pass", durationMs: 0 },  // empty name → skip
        { name: "B", file: "x.ts", status: "invalid", durationMs: 0 }, // bad status → skip
      ]),
      makeRun(2, [result("A", "pass")]),
    ];
    const r = d.analyze(runs);
    assert.equal(r.total, 1); // only A is valid
  });

  await it("handles runs with zero tests", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const r = d.analyze([makeRun(1, []), makeRun(2, [])]);
    assert.equal(r.total, 0);
  });

  await it("sort order: flaky first, then by pass rate", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRun(i, [
        result("Stable", "pass"),
        result("Flaky40", i % 5 < 2 ? "pass" : "fail"),
        result("Flaky60", i % 5 < 3 ? "pass" : "fail"),
        result("Broken", "fail"),
      ])
    );
    const r = d.analyze(runs);
    const names = r.flakes.map(f => `${f.name}:${f.classification}`);
    const flakyIdx = names.findIndex(n => n.startsWith("Flaky"));
    const brokenIdx = names.findIndex(n => n.startsWith("Broken"));
    const stableIdx = names.findIndex(n => n.startsWith("Stable"));
    assert(flakyIdx < brokenIdx, "flaky should come before broken");
    assert(brokenIdx < stableIdx, "broken should come before stable");
  });

  await it("threshold boundaries: 0.05 edge", () => {
    const d = new FlakeDetector({ ...BASE_CONFIG, flakyThresholdLow: 0.05, flakyThresholdHigh: 0.95 });
    // 0% pass → stable_fail (≤ 0.05)
    const runs1 = Array.from({ length: 5 }, () => makeRun(1, [result("A", "fail")]));
    assert.equal(d.analyze(runs1).flakes[0].classification, "stable_fail");

    // 6% pass → flaky (> 0.05)
    const runs2 = [];
    for (let i = 0; i < 5; i++) runs2.push(makeRun(i, [result("B", i === 0 ? "pass" : "fail")]));
    // 1/5 = 0.2 > 0.05, so flaky
    assert.equal(d.analyze(runs2).flakes[0].classification, "flaky");
  });

  await it("distinguishes tests across files with same name", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 3 }, (_, i) =>
      makeRun(i, [
        result("init", "pass", "src/a.ts"),
        result("init", i % 2 === 0 ? "pass" : "fail", "src/b.ts"),
      ])
    );
    const r = d.analyze(runs);
    assert.equal(r.total, 2);
    const aInit = r.flakes.find(f => f.file === "src/a.ts");
    const bInit = r.flakes.find(f => f.file === "src/b.ts");
    assert.equal(aInit.classification, "stable_pass");
    assert.equal(bInit.classification, "flaky");
  });

});
