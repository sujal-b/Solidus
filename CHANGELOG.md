# Changelog

## 0.1.0 (2026-06-30)

### Features
- `solidus analyze` — statistical flaky-test detection from JSON test results
- `solidus report` — view the latest flake report
- `solidus init` — scaffold `.solidus/` directory
- `solidus status` — show history stats (run count, latest run)
- `solidus clear` — wipe all stored history

### Core
- Layered config: defaults → config file (`.solidusrc`) → env vars (`SOLIDUS_*`) → CLI flags
- JSON-file-backed history store with atomic writes (crash-safe)
- Cross-platform file locking via `O_EXCL` (safe for parallel CI runners)
- Input validation for all test run data (rejects malformed JSON early)
- Typed error hierarchy (`SolidusError`, `ValidationError`, `HistoryError`, etc.)

### CI Integrations
- GitHub Actions composite action (`solidus`) with step outputs
- GitHub Actions annotations (`--github`): warning annotations on flaky test files
- GitHub Actions step summary with flake report table
- `--fail-on-flaky` flag for gating PRs

### Security
- Zero telemetry, zero network calls
- Test name sanitization in CI annotation output
- No `require()`/`import()` from user-controlled paths
- Same-device atomic temp files (no EXDEV errors)

### Testing
- 32 unit/integration tests (Node built-in test runner)
- Tested across Node 18/20/22 on ubuntu + windows
- Edge cases: empty runs, corrupt data, all-skip, boundary thresholds, cross-file dedup

### Quality
- Pure ESM (type: module)
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`)
- Zero native dependencies (portable across platforms)
