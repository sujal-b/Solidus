# solidus

[![npm version](https://img.shields.io/npm/v/solidus)](https://www.npmjs.com/package/solidus)
[![License](https://img.shields.io/npm/l/solidus)](LICENSE)
[![Node](https://img.shields.io/node/v/solidus)](package.json)

**Statistical flaky-test detection & quarantine. Trust your CI again.**

Flaky tests (tests that randomly pass/fail with no code change) erode CI trust, waste dev time, and let real bugs slip through. solidus tracks test results across runs, automatically detects flakiness using statistical pass-rate analysis, and annotates your CI so your team knows which tests to fix.

## Features

- **Zero config** — `npx solidus analyze -i results.json`
- **CI-native** — GitHub Actions annotations, step summaries, composite action
- **Statistical detection** — pass rate over N runs, not guesswork
- **Auto-quarantine** — optionally exclude flaky tests from CI gate
- **Cross-platform** — Windows, macOS, Linux (pure JS, zero native deps)
- **Crash-safe** — atomic file writes, file locks for parallel CI runners
- **Privacy-first** — no telemetry, no network calls, no servers

## Quick start

```bash
# Install
npm install -g solidus

# Init project
cd my-project
solidus init

# Run tests, export results as JSON
npm test -- --json --outputFile=results.json

# Analyze for flakiness
solidus analyze -i results.json

# See: "2 flaky, 14 stable, 0 broken"
```

**Sample output:**

```
solidus flake report
  14 stable  2 flaky  0 broken
  Total: 16 tests across all runs

  Tests needing attention:
    ⚠️ Dashboard loads data (6/10 passed)
    ⚠️ Payment processes (7/10 passed)
```

## How it works

```
Test runs (JSON)
      │
      ▼
┌─────────────┐     ┌──────────────┐
│ HistoryStore │────▶│ FlakeDetector│
│ (JSON files) │     │ (pass rate   │
│  crash-safe  │     │  stateless)  │
└─────────────┘     └──────┬───────┘
                           ▼
              ┌──────────────────────┐
              │ CLI output / CI       │
              │ annotations / summary │
              └──────────────────────┘
```

Each test run is saved as a JSON file in `.solidus/history/`. Analysis reads the last N runs, computes pass rates, and classifies every test. No database, no daemon, no cloud.

## CLI Reference

```
Usage: solidus <command> [options]

Commands:
  analyze     Analyze test results for flakiness
  report      Show latest flake report
  init        Initialize .solidus directory
  status      Show history stats
  clear       Delete all stored history
```

### `analyze`

| Option | Default | Description |
|--------|---------|-------------|
| `-i, --input <file>` | stdin | Test results JSON file |
| `--db-path <path>` | `.solidus/history.db` | History storage path |
| `--window <n>` | `10` | Recent runs to consider |
| `--min-runs <n>` | `3` | Min runs before classification |
| `--auto-quarantine` | `false` | Auto-quarantine flaky tests |
| `--log-level <level>` | `info` | silent\|error\|warn\|info\|debug |
| `--json` | — | Machine-readable JSON output |
| `--github` | — | GitHub Actions annotations |
| `--fail-on-flaky` | — | Exit 1 if flaky tests found |

### `report`

| Option | Default | Description |
|--------|---------|-------------|
| `--db-path <path>` | `.solidus/history.db` | History storage path |
| `--json` | — | Machine-readable JSON output |

### `status`

| Option | Default | Description |
|--------|---------|-------------|
| `--db-path <path>` | `.solidus/history.db` | History storage path |

## Input Format

Pipe your test runner's JSON output into solidus:

```json
{
  "id": "run_abc123",
  "timestamp": "2026-06-30T12:00:00Z",
  "commit": "abc123",
  "branch": "main",
  "ciRunId": "ci-12345",
  "results": [
    {
      "name": "Login renders form",
      "file": "src/Login.test.tsx",
      "status": "pass",
      "durationMs": 12
    },
    {
      "name": "Dashboard loads data",
      "file": "src/Dashboard.test.tsx",
      "status": "fail",
      "durationMs": 156,
      "error": "TimeoutError: request timed out"
    }
  ]
}
```

## Classification

| Label | Condition | Pass Rate | Meaning |
|-------|-----------|:---------:|---------|
| ✅ stable_pass | `passRate >= thresholdHigh` (default 0.95) | ≥ 95% | Healthy |
| ❌ stable_fail | `passRate <= thresholdLow` (default 0.05) | ≤ 5% | Consistently broken |
| ⚠️ flaky | between thresholds | 5–95% | Needs investigation |
| 📊 insufficient_data | `< minRuns` runs (default 3) | — | Not enough history |

## Configuration

solidus loads config from 4 sources (highest priority wins):

1. **CLI flags** — `--window 20`
2. **Environment vars** — `SOLIDUS_WINDOW=20`
3. **Config file** — `.solidusrc` (JSON)
4. **Defaults** — sensible built-in values

### Environment variables

| Variable | Maps to |
|----------|---------|
| `SOLIDUS_FLAKY_LOW` | `flakyThresholdLow` |
| `SOLIDUS_FLAKY_HIGH` | `flakyThresholdHigh` |
| `SOLIDUS_WINDOW` | `windowSize` |
| `SOLIDUS_MIN_RUNS` | `minRuns` |
| `SOLIDUS_DB_PATH` | `dbPath` |
| `SOLIDUS_AUTO_QUARANTINE` | `autoQuarantine` |
| `SOLIDUS_LOG_LEVEL` | `logLevel` |

### Config file (`.solidusrc`)

```json
{
  "windowSize": 20,
  "minRuns": 5,
  "flakyThresholdLow": 0.1,
  "flakyThresholdHigh": 0.9,
  "autoQuarantine": true,
  "logLevel": "info"
}
```

## GitHub Actions

### Composite action (recommended)

```yaml
- run: npm test -- --json --outputFile=test-results.json
- uses: solidus/solidus/.github/actions/solidus@v1
  with:
    results-file: test-results.json
    fail-on-flaky: true
```

### Direct CLI

```yaml
- run: npm test -- --json --outputFile=results.json
- run: npx solidus analyze -i results.json --github
  env:
    SOLIDUS_WINDOW: 15
```

Both methods produce:
- Warning annotations on flaky test source files
- Error annotations on consistently-failing tests
- Step summary with flake report table
- Step outputs: `flaky-count`, `stable-count`, `broken-count`, `quarantined-count`

## Jest Reporter

Add to `jest.config.js`:

```js
module.exports = {
  reporters: [
    "default",
    ["solidus/dist/plugins/jest.js", { dbPath: ".solidus/history.db" }]
  ]
};
```

Now every `npm test` auto-collects history and prints a flake report.

## Why not just retry?

Retry hides flakiness. solidus **surfaces** it. You cannot fix what you do not measure.

Teams that retry flaky tests see them multiply — once a test is known to be flaky but ignored, more appear. solidus gives you visibility, data, and a path to zero flaky tests.

## Security

- Zero telemetry, zero network calls
- Test names sanitized in CI annotations
- No `require()`/`import()` from user-controlled paths
- Atomic writes + file locks for thread safety
- [Full security policy](SECURITY.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
