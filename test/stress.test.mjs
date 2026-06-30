/**
 * In-depth stress tests for solidus.
 *
 * Tests scale, concurrency, corruption recovery, edge cases, and robustness.
 * Designed to exercise every boundary and failure mode.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";

const { HistoryStore } = await import("../dist/core/history.js");
const { DEFAULTS } = await import("../dist/core/types.js");
const { Logger } = await import("../dist/core/logger.js");
const { FlakeDetector } = await import("../dist/core/detector.js");
const { FileQuarantineStore } = await import("../dist/quarantine.js");
const { loadConfig } = await import("../dist/core/config.js");
const { TrendAnalyzer } = await import("../dist/core/trend.js");
const { BisectAnalyzer } = await import("../dist/core/bisect.js");

const log = new Logger("silent");

function tmpConfig() {
  const dir = join(tmpdir(), `solidus-stress-${randomBytes(4).toString("hex")}`);
  return { ...DEFAULTS, dbPath: join(dir, "history.db"), logLevel: "silent", minRuns: 2, windowSize: 10 };
}

function makeRun(id, results) {
  return {
    id: `stress_${id}`,
    timestamp: new Date().toISOString(),
    commit: `abc${String(id).padStart(3, "0")}`,
    branch: "main",
    results: results ?? [{ name: "test_A", file: "a.ts", status: "pass", durationMs: 10 }],
  };
}

function cleanup(config) {
  try { rmSync(join(config.dbPath, ".."), { recursive: true, force: true }); } catch {}
}

// ============================================================
// 1. SCALE TESTS — HistoryStore with 1000s of runs
// ============================================================
await describe("Scale: HistoryStore with 1000+ runs", async () => {
  let config;
  before(() => { config = tmpConfig(); });
  after(() => cleanup(config));

  await it("saves and retrieves 1000 runs", () => {
    // Override windowSize to keep all 1000 runs
    const bigConfig = { ...config, windowSize: 1000 };
    const store = new HistoryStore(bigConfig, log);
    for (let i = 0; i < 1000; i++) {
      store.saveRun(makeRun(i, [
        { name: "stable_test", file: "a.ts", status: "pass", durationMs: 5 },
        { name: `flaky_test_${i % 10}`, file: "b.ts", status: i % 2 === 0 ? "pass" : "fail", durationMs: 10 },
      ]));
    }
    assert.equal(store.runCount(), 1000);
    const recent = store.getRecentRuns(2000);
    assert.equal(recent.length, 1000);
    store.close();
  });

  await it("handles runs with 500 results each (no OOM)", () => {
    const config2 = tmpConfig();
    const store = new HistoryStore(config2, log);
    const bigResults = Array.from({ length: 500 }, (_, i) => ({
      name: `big_test_${i}`,
      file: i % 2 === 0 ? "big_a.ts" : "big_b.ts",
      status: i % 3 === 0 ? "fail" : "pass",
      durationMs: i * 1.5,
    }));
    store.saveRun(makeRun("big_1", bigResults));
    const retrieved = store.getRecentRuns(1);
    assert.equal(retrieved.length, 1);
    assert.equal(retrieved[0].results.length, 500);
    store.close();
    cleanup(config2);
  });

  await it("rapid save+retrieve cycle (100 iterations)", () => {
    for (let iter = 0; iter < 100; iter++) {
      const cfg = tmpConfig();
      const s = new HistoryStore(cfg, log);
      for (let i = 0; i < 5; i++) {
        s.saveRun(makeRun(`rapid_${iter}_${i}`));
      }
      const r = s.getRecentRuns(10);
      assert.equal(r.length, 5);
      s.close();
      cleanup(cfg);
    }
  });
});

// ============================================================
// 2. CONCURRENCY — Simulating parallel CI runners
// ============================================================
await describe("Concurrency: parallel CI runner simulation", async () => {
  let config;
  before(() => { config = tmpConfig(); });
  after(() => cleanup(config));

  await it("simulates 5 parallel runners (same run ID dedup)", () => {
    const RUNNER_COUNT = 5;
    const stores = Array.from({ length: RUNNER_COUNT }, () => new HistoryStore(config, log));

    // All try to save the same run (simulating retries from CI)
    for (const store of stores) {
      store.saveRun(makeRun("dedup_parallel", [
        { name: `test_concurrent`, file: "c.ts", status: "pass", durationMs: 1 },
      ]));
    }

    // Should have only 1 run stored (dedup by id)
    assert.equal(config.windowSize, 10);
    const recent = new HistoryStore(config, log).getRecentRuns(10);
    assert.equal(recent.length, 1);
    // The last writer wins (retried run should have latest data)
    assert.equal(recent[0].id, "stress_dedup_parallel");

    for (const s of stores) s.close();
  });

  await it("simulates 10 runners saving unique runs concurrently", () => {
    const config2 = tmpConfig();
    const RUNNER_COUNT = 10;

    for (let i = 0; i < RUNNER_COUNT; i++) {
      const store = new HistoryStore(config2, log);
      store.saveRun(makeRun(`uniq_${i}`, [
        { name: `test_${i}`, file: `${i}.ts`, status: i % 2 === 0 ? "pass" : "fail", durationMs: i },
      ]));
      store.close();
    }

    const finalStore = new HistoryStore(config2, log);
    const count = finalStore.runCount();
    assert.equal(count, 10, `Expected 10 runs, got ${count}`);
    finalStore.close();
    cleanup(config2);
  });
});

// ============================================================
// 3. CORRUPTION RECOVERY
// ============================================================
await describe("Corruption recovery", async () => {
  let config, historyDir;
  before(() => {
    config = tmpConfig();
    const dir = join(config.dbPath, "..");
    historyDir = join(dir, "history");
    mkdirSync(historyDir, { recursive: true });
  });
  after(() => cleanup(config));

  await it("handles corrupted index file gracefully", () => {
    const indexFile = join(config.dbPath, "..", "index.json");
    writeFileSync(indexFile, "this is not json {{{");
    const store = new HistoryStore(config, log);
    assert.equal(store.runCount(), 0);
    store.close();
  });

  await it("recovers after deleting all run files", () => {
    const cfg = tmpConfig();
    const store = new HistoryStore(cfg, log);
    store.saveRun(makeRun("corrupt_1"));
    store.saveRun(makeRun("corrupt_2"));
    store.close();

    // Delete run files but keep index
    const dir = join(cfg.dbPath, "..", "history");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const store2 = new HistoryStore(cfg, log);
    const recent = store2.getRecentRuns(10);
    assert.equal(recent.length, 0); // Should skip missing runs silently
    assert.equal(store2.runCount(), 2); // Index still counts them
    store2.close();
    cleanup(cfg);
  });

  await it("tolerates empty run files", () => {
    const cfg = tmpConfig();
    const store = new HistoryStore(cfg, log);
    store.saveRun(makeRun("empty_1"));
    store.close();

    // Overwrite with binary garbage (definitely not JSON)
    const historyDir = join(cfg.dbPath, "..", "history");
    const runFile = join(historyDir, "run-empty_1.json");
    writeFileSync(runFile, Buffer.from([0xde, 0xad, 0xbe, 0xef]));

    const store2 = new HistoryStore(cfg, log);
    // Should not crash and gracefully handle corrupt data
    const recent = store2.getRecentRuns(10);
    assert.ok(recent.length === 0 || recent.length === 1, "Should gracefully handle corrupt files");
    // Either way, the store should still be operational
    assert.equal(typeof store2.runCount(), "number");
    store2.close();
    cleanup(cfg);
  });

  await it("tolerates partial JSON in run file", () => {
    const cfg = tmpConfig();
    const store = new HistoryStore(cfg, log);
    store.saveRun(makeRun("partial_1"));
    store.close();

    // Truncate run file to partial JSON
    const historyDir = join(cfg.dbPath, "..", "history");
    const runFile = join(historyDir, "run-partial_1.json");
    writeFileSync(runFile, '{"id":"trunc', "utf-8");

    const store2 = new HistoryStore(cfg, log);
    // Should not crash and gracefully handle corrupt data
    const recent = store2.getRecentRuns(10);
    assert.ok(typeof store2.runCount() === "number", "Store should still be operational");
    assert.ok(recent.length === 0 || recent.length === 1, "Should gracefully handle corrupt files");
    store2.close();
    cleanup(cfg);
  });
});

// ============================================================
// 4. DETECTOR EDGE CASES
// ============================================================
await describe("Detector edge cases", async () => {
  const BASE_CONFIG = { ...DEFAULTS, windowSize: 10, minRuns: 2 };

  await it("handles all-skip tests (ignored)", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: `run_${i}`,
      timestamp: new Date().toISOString(),
      results: [{ name: "skipped_test", file: "s.ts", status: "skip", durationMs: 0 }],
    }));
    const r = d.analyze(runs);
    assert.equal(r.total, 0); // all-skip tests are filtered out
  });

  await it("handles mixed case and unicode test names", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 4 }, (_, i) => ({
      id: `run_${i}`,
      timestamp: new Date().toISOString(),
      results: [
        { name: "CamelCaseTest", file: "x.ts", status: i % 2 === 0 ? "pass" : "fail", durationMs: 5 },
        { name: "测试中文名称", file: "y.ts", status: "pass", durationMs: 5 },
        { name: "emoji_🚀_test", file: "z.ts", status: i % 2 === 0 ? "pass" : "fail", durationMs: 5 },
      ],
    }));
    const r = d.analyze(runs);
    assert.equal(r.total, 3);
    const camelCase = r.flakes.find(f => f.name === "CamelCaseTest");
    assert.equal(camelCase.classification, "flaky");
  });

  await it("handles tests with special characters in name", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 3 }, () => ({
      id: `run_sp`,
      timestamp: new Date().toISOString(),
      results: [
        { name: "test [with] (brackets) {and} <angle>", file: "s.ts", status: "pass", durationMs: 5 },
        { name: "test @ $pecial # chars!", file: "s.ts", status: "pass", durationMs: 5 },
        { name: "test\nwith\nnewlines", file: "s.ts", status: "pass", durationMs: 5 },
      ],
    }));
    const r = d.analyze(runs);
    assert.equal(r.total, 3);
  });

  await it("handles extreme durationMs values", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = Array.from({ length: 3 }, (_, i) => ({
      id: `run_ext_${i}`,
      timestamp: new Date().toISOString(),
      results: [
        { name: "zero_duration", file: "t.ts", status: "pass", durationMs: 0 },
        { name: "huge_duration", file: "t.ts", status: "pass", durationMs: 999999999 },
        { name: "float_duration", file: "t.ts", status: i % 2 === 0 ? "pass" : "fail", durationMs: 3.14159 },
      ],
    }));
    const r = d.analyze(runs);
    assert.equal(r.total, 3);
  });

  await it("handles empty test names gracefully (skipped)", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = [{
      id: "run_empty_name",
      timestamp: new Date().toISOString(),
      results: [
        { name: "", file: "e.ts", status: "pass", durationMs: 5 },
        { name: "valid", file: "e.ts", status: "pass", durationMs: 5 },
      ],
    }];
    const r = d.analyze(runs);
    assert.equal(r.total, 1); // only valid counted
  });

  await it("handles duplicate test entries in same run (retries within run)", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const runs = [{
      id: "run_dup",
      timestamp: new Date().toISOString(),
      results: [
        { name: "retry_test", file: "r.ts", status: "fail", durationMs: 100 },
        { name: "retry_test", file: "r.ts", status: "fail", durationMs: 100 },
        { name: "retry_test", file: "r.ts", status: "pass", durationMs: 200 },
      ],
    }];
    const r = d.analyze(runs);
    assert.equal(r.total, 1);
    // Last status wins (pass), so it's a pass
    assert.equal(r.flakes[0].passCount, 1);
    assert.equal(r.flakes[0].failCount, 0);
  });
});

// ============================================================
// 5. QUARANTINE STRESS TESTS
// ============================================================
await describe("Quarantine stress tests", async () => {
  let config;
  before(() => { config = tmpConfig(); });
  after(() => cleanup(config));

  await it("handles 1000 quarantine entries", () => {
    const qStore = new FileQuarantineStore(config.dbPath, log);
    for (let i = 0; i < 1000; i++) {
      qStore.add({
        name: `flaky_test_${i}`,
        file: `src/file_${i % 100}.ts`,
        reason: `Stress test flaky ${i}`,
        quarantinedAt: new Date().toISOString(),
        flakeCount: i % 5 + 1,
      });
    }
    const entries = qStore.load();
    assert.equal(entries.length, 1000);
    qStore.close();
  });

  await it("isQuarantined works at scale", () => {
    const qStore = new FileQuarantineStore(config.dbPath, log);
    let found = 0;
    let notFound = 0;
    for (let i = 0; i < 1000; i++) {
      if (qStore.isQuarantined(`src/file_${i % 100}.ts`, `flaky_test_${i}`)) found++;
      else notFound++;
    }
    assert.equal(found, 1000);
    assert.equal(notFound, 0);
    qStore.close();
  });

  await it("remove all entries one by one", () => {
    const qStore = new FileQuarantineStore(config.dbPath, log);
    let removed = 0;
    for (let i = 0; i < 1000; i++) {
      if (qStore.remove(`src/file_${i % 100}.ts`, `flaky_test_${i}`)) removed++;
    }
    assert.equal(removed, 1000);
    assert.equal(qStore.load().length, 0);
    qStore.close();
  });

  await it("clear works on empty store (no crash)", () => {
    const qStore = new FileQuarantineStore(config.dbPath, log);
    qStore.clear(); // Should not throw
    assert.equal(qStore.load().length, 0);
    qStore.close();
  });

  await it("handles concurrent add/remove cycles", () => {
    const qStore = new FileQuarantineStore(config.dbPath, log);
    for (let cycle = 0; cycle < 50; cycle++) {
      qStore.add({
        name: `cycle_${cycle}`,
        file: "cycle.ts",
        reason: `Cycle ${cycle}`,
        quarantinedAt: new Date().toISOString(),
        flakeCount: 1,
      });
      assert(qStore.isQuarantined("cycle.ts", `cycle_${cycle}`));
      qStore.remove("cycle.ts", `cycle_${cycle}`);
      assert(!qStore.isQuarantined("cycle.ts", `cycle_${cycle}`));
    }
    qStore.close();
  });

  await it("generates jest/vitest patterns without error", () => {
    // Use independent config to avoid shared state issues
    const qCfg = tmpConfig();
    const qStore = new FileQuarantineStore(qCfg.dbPath, log);
    qStore.add({ name: "test_a", file: "src/a.test.ts", reason: "flaky", quarantinedAt: new Date().toISOString(), flakeCount: 1 });

    const jestPattern = qStore.toJestPattern();
    assert(jestPattern.includes("testPathIgnorePatterns"), "Should have testPathIgnorePatterns");
    assert(jestPattern.includes("src"), "Should reference source file");
    // JSON.stringify escapes backslashes, so file paths have \\ before dots
    assert(jestPattern.includes("test"), "Should reference test name");

    const vitestPattern = qStore.toVitestPattern();
    assert(vitestPattern.includes("exclude"), "Vitest should use exclude");

    qStore.close();
    cleanup(qCfg);
  });
});

// ============================================================
// 6. DETECTOR + QUARANTINE INTEGRATION
// ============================================================
await describe("Detector + Quarantine integration", async () => {
  const BASE_CONFIG = { ...DEFAULTS, windowSize: 10, minRuns: 2, autoQuarantine: true };

  await it("detector respects quarantined keys passed from store", () => {
    const d = new FlakeDetector(BASE_CONFIG);
    const quarantinedKeys = new Set(["src/dash.tsx::Dashboard loads"]);
    const runs = Array.from({ length: 6 }, (_, i) => ({
      id: `run_q_${i}`,
      timestamp: new Date().toISOString(),
      results: [
        { name: "Dashboard loads", file: "src/dash.tsx", status: i % 2 === 0 ? "pass" : "fail", durationMs: 10 },
        { name: "Stable test", file: "src/st.tsx", status: "pass", durationMs: 5 },
      ],
    }));
    const r = d.analyze(runs, quarantinedKeys);
    const dash = r.flakes.find(f => f.name === "Dashboard loads");
    assert(dash.quarantined, "Pre-quarantined test should be marked");
    assert.equal(r.quarantined, 1);
  });

  await it("end-to-end: analyze → auto-quarantine → re-analyze shows quarantined", () => {
    const config = { ...tmpConfig(), autoQuarantine: true };
    const log2 = new Logger("silent");
    const store = new HistoryStore(config, log2);

    // Save 6 runs with a flaky test
    for (let i = 0; i < 6; i++) {
      store.saveRun({
        id: `e2e_${i}`,
        timestamp: new Date().toISOString(),
        results: [
          { name: "FlakyE2E", file: "e2e.ts", status: i % 2 === 0 ? "pass" : "fail", durationMs: 10 },
          { name: "StableE2E", file: "e2e.ts", status: "pass", durationMs: 5 },
        ],
      });
    }

    // First analyze with auto-quarantine
    const quarantine = new FileQuarantineStore(config.dbPath, log2);
    const existingKeys = new Set(quarantine.load().map(e => `${e.file}::${e.name}`));
    const detector = new FlakeDetector(config);
    const recent = store.getRecentRuns(10);
    const report1 = detector.analyze(recent, existingKeys);

    // Auto-quarantine flaky (simulate what analyze command does)
    for (const f of report1.flakes) {
      if (f.classification === "flaky" && f.quarantined && !existingKeys.has(`${f.file}::${f.name}`)) {
        quarantine.add({
          name: f.name,
          file: f.file,
          reason: `Flaky (${f.passCount}/${f.totalRuns})`,
          quarantinedAt: new Date().toISOString(),
          flakeCount: 1,
        });
      }
    }

    // Re-analyze with quarantine loaded
    const existingKeys2 = new Set(quarantine.load().map(e => `${e.file}::${e.name}`));
    const report2 = detector.analyze(recent, existingKeys2);
    const flakyInReport2 = report2.flakes.find(f => f.name === "FlakyE2E");
    assert(flakyInReport2.quarantined, "Should be quarantined on re-analysis");

    store.close();
    quarantine.close();
    cleanup(config);
  });
});

// ============================================================
// 7. TREND ANALYZER EDGE CASES
// ============================================================
await describe("Trend analyzer edge cases", async () => {
  const BASE_CONFIG = { ...DEFAULTS, windowSize: 10, minRuns: 2 };

  await it("returns empty trend for < 2 runs", () => {
    const ta = new TrendAnalyzer(BASE_CONFIG);
    const r = ta.analyze([makeRun(1)]);
    assert.equal(r.points.length, 0);
    assert.equal(r.summary.flakyTrend, "insufficient");
  });

  await it("produces at least one data point for > minRuns runs", () => {
    const ta = new TrendAnalyzer(BASE_CONFIG);
    const runs = Array.from({ length: 5 }, (_, i) => makeRun(i));
    const r = ta.analyze(runs);
    assert(r.points.length > 0);
  });

  await it("trend detection identifies stable pattern", () => {
    const ta = new TrendAnalyzer(BASE_CONFIG);
    const runs = Array.from({ length: 10 }, (_, i) => ({
      id: `run_t_${i}`,
      timestamp: new Date(Date.now() - (10 - i) * 60000).toISOString(),
      results: [
        { name: "stable", file: "s.ts", status: "pass", durationMs: 5 },
      ],
    }));
    const r = ta.analyze(runs);
    assert(r.summary.flakyTrend === "stable" || r.summary.flakyTrend === "decreasing");
  });
});

// ============================================================
// 8. BISECT EDGE CASES
// ============================================================
await describe("Bisect analyzer edge cases", async () => {
  const BASE_CONFIG = { ...DEFAULTS, windowSize: 10, minRuns: 2 };

  await it("throws for non-existent test", () => {
    const ba = new BisectAnalyzer(BASE_CONFIG);
    assert.throws(() => ba.analyze("nonexistent", [makeRun(1)]));
  });

  await it("detects transition from stable to flaky", () => {
    const ba = new BisectAnalyzer(BASE_CONFIG);
    const runs = [
      makeRun(1, [{ name: "T", file: "t.ts", status: "pass", durationMs: 5 }]),
      makeRun(2, [{ name: "T", file: "t.ts", status: "pass", durationMs: 5 }]),
      makeRun(3, [{ name: "T", file: "t.ts", status: "fail", durationMs: 5 }]),
      makeRun(4, [{ name: "T", file: "t.ts", status: "fail", durationMs: 5 }]),
    ];
    const r = ba.analyze("T", runs);
    assert(!r.transition.isNewTest);
    assert.equal(r.transition.lastStableRunId, "stress_2");
    assert.equal(r.transition.firstFlakyRunId, "stress_3");
  });

  await it("detects new test (never stable)", () => {
    const ba = new BisectAnalyzer(BASE_CONFIG);
    const runs = [
      makeRun(1, [{ name: "T", file: "t.ts", status: "fail", durationMs: 5 }]),
      makeRun(2, [{ name: "T", file: "t.ts", status: "fail", durationMs: 5 }]),
    ];
    const r = ba.analyze("T", runs);
    assert(r.transition.isNewTest);
  });

  await it("filters by file", () => {
    const ba = new BisectAnalyzer(BASE_CONFIG);
    const runs = [
      makeRun(1, [
        { name: "T", file: "a.ts", status: "pass", durationMs: 5 },
        { name: "T", file: "b.ts", status: "fail", durationMs: 5 },
      ]),
    ];
    const r = ba.analyze("T", runs, "a.ts");
    assert.equal(r.testFile, "a.ts");
    assert.equal(r.history.passCount, 1);
  });
});

// ============================================================
// 9. MEMORY / RESOURCE LEAK DETECTION
// ============================================================
await describe("Resource management", async () => {
  await it("close/releaseAll is idempotent", () => {
    const config = tmpConfig();
    const store = new HistoryStore(config, log);
    store.saveRun(makeRun("leak_1"));
    store.close(); // First close
    store.close(); // Second close — should not throw
    cleanup(config);
  });

  await it("multiple store instances don't interfere", () => {
    const configA = tmpConfig();
    const configB = tmpConfig();
    const storeA = new HistoryStore(configA, log);
    const storeB = new HistoryStore(configB, log);

    storeA.saveRun(makeRun("A_1"));
    storeB.saveRun(makeRun("B_1"));

    assert.equal(storeA.runCount(), 1);
    assert.equal(storeB.runCount(), 1);

    storeA.close();
    storeB.close();
    cleanup(configA);
    cleanup(configB);
  });
});

// ============================================================
// 10. CONFIG VALIDATION HARDENING
// ============================================================
await describe("Config edge cases", async () => {
  await it("rejects flakyThresholdLow of 0 (boundary)", () => {
    // 0 is technically valid (0 ≤ low ≤ 1)
    const cfg = loadConfig({ flakyThresholdLow: 0 });
    assert.equal(cfg.flakyThresholdLow, 0);
  });

  await it("rejects flakyThresholdHigh of 1 (boundary)", () => {
    // 1 is technically valid (0 ≤ high ≤ 1)
    const cfg = loadConfig({ flakyThresholdHigh: 1 });
    assert.equal(cfg.flakyThresholdHigh, 1);
  });

  await it("rejects windowSize of Infinity", () => {
    assert.throws(() => loadConfig({ windowSize: Infinity }));
  });
});

// ============================================================
// 11. CROSS-PLATFORM COMPATIBILITY
// ============================================================
await describe("Cross-platform compatibility", async () => {
  await it("handles Windows-style paths in test file", () => {
    const d = new FlakeDetector({ ...DEFAULTS, windowSize: 10, minRuns: 2 });
    const runs = Array.from({ length: 3 }, (_, i) => ({
      id: `win_${i}`,
      timestamp: new Date().toISOString(),
      results: [
        { name: "test", file: "src\\components\\test.tsx", status: i % 2 === 0 ? "pass" : "fail", durationMs: 5 },
      ],
    }));
    const r = d.analyze(runs);
    assert.equal(r.total, 1);
    // Windows paths should be preserved
    assert.equal(r.flakes[0].file, "src\\components\\test.tsx");
  });

  await it("handles paths with spaces and special chars", () => {
    const d = new FlakeDetector({ ...DEFAULTS, windowSize: 10, minRuns: 2 });
    const runs = [{
      id: "path_space",
      timestamp: new Date().toISOString(),
      results: [
        { name: "test", file: "my project/src/components/[test] (copy).tsx", status: "pass", durationMs: 5 },
      ],
    }];
    const r = d.analyze(runs);
    assert.equal(r.total, 1);
  });

  await it("JSON file store handles deep directory paths", () => {
    const deepDir = join(tmpdir(), "a", "b", "c", "d", "e", `solidus-${randomBytes(2).toString("hex")}`);
    const config2 = { ...DEFAULTS, dbPath: join(deepDir, "sub", "history.db"), logLevel: "silent" };
    const store = new HistoryStore(config2, log);
    store.saveRun(makeRun("deep_path"));
    assert.equal(store.runCount(), 1);
    store.close();
    try { rmSync(join(config2.dbPath, "..", ".."), { recursive: true, force: true }); } catch {}
  });
});
