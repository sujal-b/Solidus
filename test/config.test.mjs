import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const { loadConfig } = await import("../dist/core/config.js");
const { DEFAULTS } = await import("../dist/core/types.js");

function tmpFile(prefix) {
  return join(tmpdir(), `solidus-${prefix}-${randomBytes(4).toString("hex")}.json`);
}

await describe("Config loading", async () => {

  await it("defaults when no config file or env", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.flakyThresholdLow, 0.05);
    assert.equal(cfg.flakyThresholdHigh, 0.95);
    assert.equal(cfg.windowSize, 10);
    assert.equal(cfg.logLevel, "info");
    assert(!cfg.autoQuarantine);
  });

  await it("CLI overrides take priority", () => {
    const cfg = loadConfig({ windowSize: 5, autoQuarantine: true });
    assert.equal(cfg.windowSize, 5);
    assert(cfg.autoQuarantine);
  });

  await it("config file is read and applied", async () => {
    const tmpDir = join(tmpdir(), `solidus-cfg-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, ".solidusrc");
    writeFileSync(cfgPath, JSON.stringify({ logLevel: "debug", minRuns: 7 }));
    const origDir = process.cwd();
    process.chdir(tmpDir);
    const cfg = loadConfig({});
    process.chdir(origDir);
    try {
      assert.equal(cfg.logLevel, "debug", `Expected debug, got ${cfg.logLevel} (_sources: ${JSON.stringify(cfg._sources)})`);
      assert.equal(cfg.minRuns, 7);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  await it("rejects invalid flakyThresholdLow", () => {
    assert.throws(() => loadConfig({ flakyThresholdLow: -0.1 }));
    assert.throws(() => loadConfig({ flakyThresholdLow: 1.5 }));
  });

  await it("rejects config where low >= high", () => {
    assert.throws(() => loadConfig({ flakyThresholdLow: 0.8, flakyThresholdHigh: 0.2 }));
  });

  await it("rejects windowSize < 2", () => {
    assert.throws(() => loadConfig({ windowSize: 1 }));
  });

  await it("rejects invalid logLevel", () => {
    assert.throws(() => loadConfig({ logLevel: "verbose" }));
  });
});
