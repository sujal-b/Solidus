import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const tests = [
  { name: "Login renders form", file: "src/Login.test.tsx", stable: true },
  { name: "Login submits", file: "src/Login.test.tsx", stable: true },
  { name: "Dashboard loads data", file: "src/Dashboard.test.tsx", stable: false },
  { name: "Nav shows links", file: "src/Nav.test.tsx", stable: true },
  { name: "Payment processes", file: "src/Payment.test.tsx", stable: false },
  { name: "Search returns results", file: "src/Search.test.tsx", stable: true },
];

function makeRun(id, flakyPass) {
  const results = tests.map((t, i) => {
    const status = t.stable ? "pass" : flakyPass.has(i) ? "pass" : "fail";
    return {
      name: t.name,
      file: t.file,
      status,
      durationMs: Math.floor(Math.random() * 200) + 5,
      error: status === "fail" ? "AssertionError: expected true to be false" : undefined,
    };
  });
  return {
    id: `run_${String(id).padStart(3, "0")}`,
    timestamp: new Date(2026, 5, 30, 10 + Math.floor(id / 4), (id * 7) % 60).toISOString(),
    commit: `abc${String(id).padStart(3, "0")}`,
    branch: "main",
    results,
  };
}

// 12 runs. Dashboard (idx2): passes on id%3∈{0,2}. Payment (idx4): passes on id%3∈{0,1}
const dir = join(__dirname, "..", ".solidus");
mkdirSync(join(dir, "history"), { recursive: true });
const index = { runs: [] };

for (let i = 0; i < 12; i++) {
  const flakyPass = new Set();
  if (i % 3 === 2 || i % 3 === 0) flakyPass.add(2);
  if (i % 3 === 0 || i % 3 === 1) flakyPass.add(4);
  const run = makeRun(i, flakyPass);
  writeFileSync(join(dir, "history", `run-${run.id}.json`), JSON.stringify(run, null, 2));
  index.runs.unshift({ id: run.id, timestamp: run.timestamp });
}

writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2));
console.log("Seeded 12 runs, 6 tests (2 flaky)");
