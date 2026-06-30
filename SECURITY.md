# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅        |

## Reporting a Vulnerability

Open an issue with the `security` label. Do not disclose exploits publicly until patched.

## Threat Model

solidus runs test data through a local analysis pipeline. Key security properties:

1. **No network calls** — solidus never phones home. Zero telemetry, zero analytics.
2. **Local-only storage** — history is stored in local JSON files. No server, no database.
3. **Input sanitization** — test names are sanitized before appearing in CI annotations (`<>"'&` removed).
4. **Atomic file writes** — history files are written to temp then renamed (crash-safe).
5. **File lock via O_EXCL** — concurrent CI runners on the same machine coordinate via exclusive-create file locks.

## Known Security Measures

- Path traversal: All file operations use resolved absolute paths. User input is never used in `require()` or `import()`.
- Injection: Test names containing shell-sensitive characters are sanitized for GitHub Actions annotation output.
- Temp files: Written with `.tmp-<random>` prefix, same-device to avoid cross-device link issues.
