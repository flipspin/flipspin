# Contributor entry points

Flipspin is the product name; compatibility identifiers and server data paths
retain their existing spellings.

Read ARCHITECTURE.md for ownership and boundaries. All paths in these guides
are relative to the repository root; run commands there unless stated otherwise.

- Backend: [backend/AGENTS.md](backend/AGENTS.md).
- Renderer: [renderer/AGENTS.md](renderer/AGENTS.md).
- Native shell: [src-tauri/AGENTS.md](src-tauri/AGENTS.md).
- Compute helper: [helper/AGENTS.md](helper/AGENTS.md).
- Shared cases: [contracts/AGENTS.md](contracts/AGENTS.md).

## Commands

- `make install` — Python 3.12 virtualenv and frontend dependencies.
- `make backend` — API on port 8000; start before the debug desktop shell.
- `make tauri` — Tauri and Vite; fixed renderer port 5173.
- `make lint` — Ruff, import contracts, ESLint, TypeScript and Clippy.
- `make test` — backend suite, including its 70% coverage gate.
- `npm test` — renderer Vitest suite, including the style guard.
- `make test-rust test-worker` — native shell and pure helper tests.
- `npm run api:generate` — regenerate types offline from the committed schema.

Use CONTRIBUTING.md for setup, contribution policy and isolated development
data, and docs/CONFIGURATION.md for environment variables. Never test against a
personal library by accident or put credentials and machine details in docs.

## What guards these rules

| Rule | Guard |
|---|---|
| Repository paths, area ownership and guide links | `scripts/check-areas.mjs` |
| Code quality and credential patterns | `make lint`; repository secret checks |
| Isolated development data | Not enforced yet; follow CONTRIBUTING.md |
