# Contributing

## Prerequisites

- Node.js >= 18
- npm

## Setup

```bash
git clone <repo>
cd solidus
npm install
npm run build
```

## Development

```bash
# Build
npm run build

# Watch (requires tsc --watch in another terminal)
npx tsc --watch

# Test
node --test test/*.test.mjs

# Seed mock data
node test/seed-data.mjs

# Run CLI
node dist/index.js analyze -i test/new-run.json
```

## Project Structure

```
src/
  index.ts          CLI entry point
  core/
    types.ts        Types + validation
    config.ts       Layered config (file/env/CLI)
    detector.ts     Statistical flake detection
    history.ts      JSON-file-backed history store
    lock.ts         Cross-platform file locking
    errors.ts       Typed error hierarchy
    logger.ts       Structured logger
  ci/
    github.ts       GitHub Actions annotations
  plugins/
    jest.ts         Jest reporter plugin
```

## Tests

Run all: `node --test test/*.test.mjs`

Write tests in plain `.mjs` importing compiled `dist/` output. Use Node's built-in test runner (`node:test` + `node:assert/strict`).

## Pull Requests

- Keep changes focused. One PR per feature/fix.
- Include tests.
- Update CHANGELOG.md.
- Run the full test suite before pushing.

## Releasing

1. Update CHANGELOG.md
2. `npm version <major|minor|patch>`
3. Push tag
4. Create GitHub Release → workflows publish to npm automatically
