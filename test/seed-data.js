const fs = require("fs");
const path = require("path");

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
    let status;
    if (t.stable) {
      status = "pass";
    } else {
      // Flaky: pass only in specific runs
      status = flakyPass.includes(i) ? "pass" : "fail";
    }
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

// Generate 12 runs with specific flaky patterns:
// Dashboard (index 2): passes in runs 2,5,8,11 → flaky
// Payment (index 4): passes in runs 0,3,6,9 → flaky
const dir = path.join(__dirname, "..", ".solidus");
fs.mkdirSync(path.join(dir, "history"), { recursive: true });
const index = { runs: [] };

for (let i = 0; i < 12; i++) {
  const flakyPass = [];
  if (i % 3 === 2 || i % 3 === 0) flakyPass.push(2);  // Dashboard
  if (i % 3 === 0 || i % 3 === 1) flakyPass.push(4);  // Payment

  const run = makeRun(i, flakyPass);
  const runFile = path.join(dir, "history", `run-${run.id}.json`);
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
  index.runs.unshift({ id: run.id, timestamp: run.timestamp });
}

fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
console.log("Mock history generated with 12 runs");
