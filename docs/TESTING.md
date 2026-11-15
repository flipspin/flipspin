# Testing

Three suites, one per half of the project, all run by CI on every push and pull
request.

| Suite | Where | Runner | Command |
|---|---|---|---|
| Server | `backend/tests/` | pytest | `make test` |
| Renderer | `renderer/src/**/*.test.ts(x)` | Vitest (jsdom) | `npm test` |
| Desktop shell | `src-tauri/src/` | `cargo test` | `cargo test --manifest-path src-tauri/Cargo.toml` |

Linting: `make lint` (ESLint + `tsc` + Clippy with `-D warnings`) and
`cd backend && ../.venv/bin/python -m ruff check .`.

## Server

```
backend/tests/
├── unit/          # one class or module, dependencies mocked
├── integration/   # FastAPI TestClient against real routes and a temp data dir
├── fixtures/      # sample data (users files, Spotify export layouts)
└── conftest.py    # shared fixtures
```

```bash
cd backend
../.venv/bin/python -m pytest                          # everything, with coverage
../.venv/bin/python -m pytest tests/unit/              # unit only
../.venv/bin/python -m pytest tests/integration/       # integration only
../.venv/bin/python -m pytest -m "not slow"            # skip slow tests
../.venv/bin/python -m pytest tests/unit/test_foo.py::TestBar::test_baz
```

`pytest.ini` turns on coverage for every run (terminal report plus
`htmlcov/index.html`) and **fails the run below 45%**. Markers are declared
strictly: `unit`, `integration`, `property`, `slow`.

Tests never touch `~/Krobi`: fixtures point every `KROBI_*` path at a temporary
directory. A new test that reads configuration should do the same.

`tests/integration/test_response_contracts.py` pins the exact shape of the
responses that shipped clients decode (the `/api/status` handshake, account and
device listings, …). If it fails, you changed a public contract — see
[API_COMPATIBILITY.md](API_COMPATIBILITY.md) before changing the test.

## Renderer

```bash
npm test                    # once
npm run test:watch          # watch mode
npx vitest run --config renderer/vitest.config.ts renderer/src/auth/auth.test.tsx
```

Nearly all renderer tests live under `renderer/src/`. They run in Spanish,
to preserve existing UI assertions even though English is the source language, so `getByText('Guardar')` reads the way the screen does.
Screens that talk to the native shell are driven through a fake bridge
(`setFakeBridgeForTest()` in `bridge.ts`) using the real channel names.

## Desktop shell

`cargo test` covers the URL and origin guards in `desktop.rs` — the checks that
stop the shell's request proxy from being pointed anywhere but the configured
server.

## Smoke test

CI also installs the server's runtime dependency set from scratch
(`backend/requirements-runtime.txt`), starts it against an empty data directory
and asserts `GET /api/health` answers 200. It catches missing runtime
dependencies and startup-path mistakes that the unit suites cannot.
