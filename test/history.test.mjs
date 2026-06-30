import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const { HistoryStore } = await import("../dist/core/history.js");
const { DEFAULTS, validateTestRun } = await import("../dist/core/types.js");
const { Logger } = await import("../dist/core/logger.js");

function tmpConfig() {
  const dir = join(tmpdir(), `solidus-test-${randomBytes(4).toString("hex")}`);
  return { ...DEFAULTS, dbPath: join(dir, "history.db"), logLevel: "silent" };
}

function makeRun(id, results) {
  return {
    id: `test_${id}`,
    timestamp: new Date().toISOString(),
    results: results ?? [{ name: "A", file: "a.ts", status: "pass", durationMs: 10 }],
  };
}

const log = new Logger("silent");

await describe("HistoryStore", async () => {
  let config;

  before(() => { config = tmpConfig(); });
  after(() => { try { rmSync(join(config.dbPath, ".."), { recursive: true, force: true }); } catch {} });

  await it("stores and retrieves a run", () => {
    const store = new HistoryStore(config, log);
    const run = makeRun("save_1");
    store.saveRun(run);
    const recent = store.getRecentRuns(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, "test_save_1");
    assert.equal(recent[0].results.length, 1);
    store.close();
  });

  await it("dedup by id (same CI run re-submitted)", () => {
    const config2 = tmpConfig();
    const store = new HistoryStore(config2, log);
    const run = makeRun("dedup_1", [{ name: "X", file: "x.ts", status: "pass", durationMs: 1 }]);
    store.saveRun(run);
    const run2 = makeRun("dedup_1", [{ name: "Y", file: "y.ts", status: "fail", durationMs: 2 }]);
    store.saveRun(run2);
    const recent = store.getRecentRuns(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].results[0].name, "Y"); // latest wins
    store.close();
    try { rmSync(join(config2.dbPath, ".."), { recursive: true, force: true }); } catch {}
  });

  await it("returns empty for missing run (corrupt index)", () => {
    const config3 = tmpConfig();
    const store = new HistoryStore(config3, log);
    const r1 = store.getRecentRuns(10);
    assert.equal(r1.length, 0);
    store.close();
    try { rmSync(join(config3.dbPath, ".."), { recursive: true, force: true }); } catch {}
  });

  await it("counts runs correctly", () => {
    const config4 = tmpConfig();
    const store = new HistoryStore(config4, log);
    assert.equal(store.runCount(), 0);
    store.saveRun(makeRun("cnt_1"));
    store.saveRun(makeRun("cnt_2"));
    assert.equal(store.runCount(), 2);
    store.close();
    try { rmSync(join(config4.dbPath, ".."), { recursive: true, force: true }); } catch {}
  });

  await it("clear removes all data", () => {
    const config5 = tmpConfig();
    const store = new HistoryStore(config5, log);
    store.saveRun(makeRun("clr_1"));
    store.saveRun(makeRun("clr_2"));
    store.clear();
    assert.equal(store.runCount(), 0);
    assert.equal(store.getRecentRuns(10).length, 0);
    store.close();
    try { rmSync(join(config5.dbPath, ".."), { recursive: true, force: true }); } catch {}
  });
});

await describe("validateTestRun", async () => {

  await it("rejects null/undefined", () => {
    const e = validateTestRun(null);
    assert(e.length > 0);
  });

  await it("rejects missing id", () => {
    const e = validateTestRun({ timestamp: "2026-01-01T00:00:00Z", results: [] });
    assert(e.some(s => s.includes("id")));
  });

  await it("rejects invalid timestamp", () => {
    const e = validateTestRun({ id: "x", timestamp: "not-a-date", results: [] });
    assert(e.some(s => s.includes("timestamp")));
  });

  await it("rejects non-array results", () => {
    const e = validateTestRun({ id: "x", timestamp: "2026-01-01T00:00:00Z", results: "nope" });
    assert(e.some(s => s.includes("results")));
  });

  await it("rejects invalid result items", () => {
    const e = validateTestRun({
      id: "x",
      timestamp: "2026-01-01T00:00:00Z",
      results: [
        { name: "", file: "", status: "invalid", durationMs: -1 },
      ],
    });
    assert(e.some(s => s.includes("name")));
    assert(e.some(s => s.includes("status")));
    assert(e.some(s => s.includes("durationMs")));
  });

  await it("accepts valid run", () => {
    const e = validateTestRun({
      id: "valid",
      timestamp: "2026-06-30T12:00:00Z",
      results: [
        { name: "test", file: "a.ts", status: "pass", durationMs: 42 },
        { name: "test2", file: "b.ts", status: "fail", durationMs: 100, error: "boom" },
      ],
    });
    assert.equal(e.length, 0);
  });

  await it("rejects negative durationMs", () => {
    const e = validateTestRun({
      id: "x",
      timestamp: "2026-01-01T00:00:00Z",
      results: [{ name: "a", file: "a.ts", status: "pass", durationMs: -5 }],
    });
    assert(e.some(s => s.includes("durationMs")));
  });

  await it("rejects NaN durationMs", () => {
    const e = validateTestRun({
      id: "x",
      timestamp: "2026-01-01T00:00:00Z",
      results: [{ name: "a", file: "a.ts", status: "pass", durationMs: NaN }],
    });
    assert(e.some(s => s.includes("durationMs")));
  });
});
