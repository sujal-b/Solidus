import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpDirs = new Set();
after(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
function tmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.add(d);
  return d;
}

await describe("Plugin reporters", async () => {

  // ---- Vitest reporter ----
  await describe("Vitest reporter", async () => {
    const { default: VitestReporter } = await import("../dist/plugins/vitest.js");

    await it("collects test results from mock Vitest task tree", () => {
      const reporter = new VitestReporter({}, {
        dbPath: join(tmpDir("tt-vitest-"), "history.db"),
        logLevel: "silent",
      });

      const mockFiles = [
        {
          file: { filepath: "src/a.test.ts" },
          name: "a.test.ts",
          type: "suite",
          tasks: [
            {
              name: "suite A",
              type: "suite",
              tasks: [
                { name: "test A1", type: "test", result: { state: "pass", duration: 10 } },
                { name: "test A2", type: "test", result: { state: "fail", duration: 20, errors: [{ message: "AssertionError" }] } },
              ],
            },
          ],
        },
        {
          file: { filepath: "src/b.test.ts" },
          name: "b.test.ts",
          type: "suite",
          tasks: [
            { name: "test B", type: "test", result: { state: "skip" } },
            { name: "test B2", type: "test", result: { state: "pass", duration: 5 } },
          ],
        },
      ];

      reporter.onTestRunEnd(mockFiles);

      // Access private state for testing — read from results via property descriptor
      const results = reporter.results;
      assert.equal(results.length, 4);
      assert.equal(results.filter(r => r.status === "pass").length, 2);
      assert.equal(results.filter(r => r.status === "fail").length, 1);
      assert.equal(results.filter(r => r.status === "skip").length, 1);
    });

    await it("handles empty task tree gracefully", () => {
      const reporter = new VitestReporter({}, {
        dbPath: join(tmpDir("tt-vitest-"), "history.db"),
        logLevel: "silent",
      });

      reporter.onTestRunEnd([]);
      assert.equal(reporter.results.length, 0);
    });

    await it("handles tasks with no result object", () => {
      const reporter = new VitestReporter({}, {
        dbPath: join(tmpDir("tt-vitest-"), "history.db"),
        logLevel: "silent",
      });

      const mockFiles = [
        {
          file: { filepath: "src/x.test.ts" },
          name: "x.test.ts",
          type: "suite",
          tasks: [
            { name: "no result", type: "test" },
          ],
        },
      ];

      reporter.onTestRunEnd(mockFiles);
      assert.equal(reporter.results.length, 1);
      assert.equal(reporter.results[0].status, "skip");
    });
  });

  // ---- Playwright reporter ----
  await describe("Playwright reporter", async () => {
    const { default: PlaywrightReporter } = await import("../dist/plugins/playwright.js");

    await it("collects test results from onTestEnd events", () => {
      const reporter = new PlaywrightReporter({
        dbPath: join(tmpDir("tt-pw-"), "history.db"),
        logLevel: "silent",
      });

      // Simulate Playwright test hierarchy
      const parentSuite = {
        title: "login suite",
        parent: null,
      };

      const fileSuite = {
        title: "login.test.ts",
        parent: parentSuite,
        location: { file: "src/login.test.ts" },
      };

      const test1 = {
        title: "renders form",
        parent: fileSuite,
        location: { file: "src/login.test.ts" },
      };

      const test2 = {
        title: "submits",
        parent: fileSuite,
        location: { file: "src/login.test.ts" },
      };

      reporter.onTestEnd(test1, { status: "passed", duration: 100 });
      reporter.onTestEnd(test2, { status: "failed", duration: 200, error: { message: "Timeout" } });

      // onEnd builds and saves the run
      reporter.onEnd();

      // Check collected results
      const results = reporter.results;
      assert.equal(results.length, 2);
      assert.equal(results[0].status, "pass");
      assert.equal(results[0].durationMs, 100);
      assert.equal(results[1].status, "fail");
      assert.equal(results[1].durationMs, 200);
    });

    await it("maps timedOut and interrupted to fail/skip", () => {
      const reporter = new PlaywrightReporter({
        dbPath: join(tmpDir("tt-pw-"), "history.db"),
        logLevel: "silent",
      });

      const parent = { title: "test.spec.ts", parent: null, location: { file: "test.spec.ts" } };

      reporter.onTestEnd(
        { title: "timedout", parent, location: { file: "test.spec.ts" } },
        { status: "timedOut", duration: 30000 },
      );
      reporter.onTestEnd(
        { title: "interrupted", parent, location: { file: "test.spec.ts" } },
        { status: "interrupted", duration: 100 },
      );

      assert.equal(reporter.results[0].status, "fail");
      assert.equal(reporter.results[1].status, "skip");
    });

    await it("handles onEnd with no results gracefully", () => {
      const reporter = new PlaywrightReporter({
        dbPath: join(tmpDir("tt-pw-"), "history.db"),
        logLevel: "silent",
      });
      // Should not throw
      reporter.onEnd();
    });

    await it("constructs full test name from parent hierarchy", () => {
      const reporter = new PlaywrightReporter({
        dbPath: join(tmpDir("tt-pw-"), "history.db"),
        logLevel: "silent",
      });

      const root = { title: "", parent: null };
      const describe1 = { title: "Dashboard", parent: root };
      const describe2 = { title: "load state", parent: describe1 };
      const test = { title: "shows spinner", parent: describe2, location: { file: "dash.spec.ts" } };

      reporter.onTestEnd(test, { status: "passed", duration: 50 });

      assert.equal(reporter.results[0].name, "Dashboard > load state > shows spinner");
    });
  });

  // ---- Mocha reporter ----
  await describe("Mocha reporter", async () => {
    const { default: MochaReporter } = await import("../dist/plugins/mocha.js");

    await it("collects results from Mocha events", () => {
      // Create a manual event emitter to simulate Mocha runner
      const events = {};
      const mockRunner = {
        on(event, cb) {
          events[event] = cb;
        },
      };

      const reporter = new MochaReporter(mockRunner, {
        reporterOptions: {
          dbPath: join(tmpDir("tt-mocha-"), "history.db"),
          logLevel: "silent",
        },
      });

      // Simulate mocha tests
      const makeTest = (title, state, duration, opts = {}) => ({
        title,
        fullTitle: () => title,
        duration,
        state,
        file: opts.file,
        parent: opts.parent || null,
        err: opts.err || null,
      });

      const test1 = makeTest("test A passes", "passed", 10, { file: "src/a.test.js" });
      const test2 = makeTest("test B fails", "failed", 20, { file: "src/a.test.js", err: { message: "Assert failed" } });
      const test3 = makeTest("test C skipped", undefined, 0, { file: "src/b.test.js" });

      // Fire events
      events["pass"](test1);
      events["fail"](test2, test2.err);
      events["pending"](test3);
      events["end"]();

      const results = reporter.results;
      assert.equal(results.length, 3);
      assert.equal(results[0].status, "pass");
      assert.equal(results[0].name, "test A passes");
      assert.equal(results[1].status, "fail");
      assert.ok(results[1].error?.includes("Assert failed"));
      assert.equal(results[2].status, "skip");
    });

    await it("derives file path from parent suite chain", () => {
      const events = {};
      const mockRunner = {
        on(event, cb) {
          events[event] = cb;
        },
      };

      const reporter = new MochaReporter(mockRunner, {
        reporterOptions: {
          dbPath: join(tmpDir("tt-mocha-"), "history.db"),
          logLevel: "silent",
        },
      });

      const nestedTest = {
        title: "deep test",
        fullTitle: () => "outer > inner > deep test",
        duration: 5,
        state: "passed",
        file: undefined, // no direct file — must get from parent
        parent: {
          title: "inner",
          file: "src/deep.test.js",
          parent: {
            title: "outer",
            file: undefined,
          },
        },
      };

      events["pass"](nestedTest);
      assert.equal(reporter.results[0].file, "src/deep.test.js");
    });

    await it("uses unknown when no file available", () => {
      const events = {};
      const mockRunner = {
        on(event, cb) {
          events[event] = cb;
        },
      };

      const reporter = new MochaReporter(mockRunner, {
        reporterOptions: {
          dbPath: join(tmpDir("tt-mocha-"), "history.db"),
          logLevel: "silent",
        },
      });

      const mysteriousTest = {
        title: "orphan",
        fullTitle: () => "orphan",
        duration: 1,
        state: "passed",
        file: undefined,
        parent: undefined,
      };

      events["pass"](mysteriousTest);
      assert.equal(reporter.results[0].file, "unknown");
    });
  });

});
