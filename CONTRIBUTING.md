# Contributing

Flipspin has one maintainer with limited review time. That shapes what is
welcome:

- **Ideas and feature requests go to [GitHub Discussions](https://github.com/flipspin/flipspin/discussions).**
  Issues track accepted work and bugs. Questions also belong in Discussions.
- **Discuss code contributions with the maintainer in an issue first.** Describe the
  change in an issue and wait for an explicit maintainer "yes, go ahead" before
  writing it. Unsolicited PRs may be closed without review because the project
  has limited capacity to review unplanned changes.
- **Small, evident fixes that restore established behaviour, and documentation
  corrections, may come directly as a PR with evidence of the defect.** Include
  a reproduction, failing test or incorrect documentation reference.
- **Security problems** go through [the security policy](.github/SECURITY.md), never a public
  issue.

The rest of this file is for when a change has been agreed, or when you simply
want to run the project yourself.

Start with [docs/architecture.md](docs/architecture.md) for the code map and boundaries.

## Set up a development environment

The repository has two halves: a Python server under `backend/`, and a desktop
client (Tauri 2 / Rust shell in `src-tauri/`, React + TypeScript renderer in
`renderer/`).

Prerequisites: **Python 3.12**, **Node.js 22+**, **Rust stable**. ffmpeg is
installed with the Python dependencies, so a system ffmpeg is optional. Python
3.13+ is not recommended yet — some audio dependencies do not publish wheels
for it.

These versions are pinned in `.tool-versions`; run `mise install` to install them.
`make install` runs this automatically when mise is on your PATH.

```bash
git clone https://github.com/flipspin/flipspin.git && cd flipspin

# Server half — the virtualenv must live at the repo root and be called .venv,
# because the Makefile and the packaging script both look for it there.
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# Client half
npm install
```

`make install` does both. `make help` lists every target.

```bash
make dev        # Isolated backend, then Tauri + its Vite server
# make frontend # browser-only UI work; do not run alongside make dev
```

Debug desktop builds connect to the backend started by `make dev`. To run
`make tauri` separately, first start an isolated backend as described below.

While the server runs it documents itself at `http://localhost:8000/docs`.

### Keep your own library out of it

Use the isolated backend and desktop together:

```sh
make dev
make stop
make dev-reset
```

`make dev` uses the gitignored `.dev-data/` tree, ignoring inherited server
path and credential overrides. It copies the bundled starter album directories
from `resources/default-songs/` and creates one owner on first run. Sign in as
`dev` with password `flipspin-development`. Starter content may be empty;
only redistributable audio belongs in that folder. Stop with Ctrl+C or
`make stop`; `make start` is an alias for `make dev`. `make dev-reset` stops
the session and deletes its data. The launcher works on macOS, Windows and Linux.

For a standalone server, set `FLIPSPIN_DATA_DIR` before `make backend`.
See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for resolution and per-path
overrides, and [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) for architecture.

## Run the tests

```bash
# Server: whole suite, with the 70% coverage gate pytest.ini enforces
make test                                   # = cd backend && ../.venv/bin/python -m pytest
cd backend && ../.venv/bin/python -m ruff check .

# Client (TypeScript renderer + Rust shell)
npm run lint
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`make lint` checks area guides, Python imports, Ruff, ESLint, `tsc` and Clippy.
CI runs the relevant Python, renderer and Rust checks for the changed areas.
The smoke job installs the server's runtime dependencies from scratch, starts
it against an empty data directory and asserts `GET /api/health` answers
200. More in [docs/TESTING.md](docs/TESTING.md).

## PR titles and changelog labels

PRs are **squash-merged**. The **PR title** becomes the commit subject and must
be at most 72 characters, in this form:

```
<area>: <imperative summary>
```

Use a lowercase area from `.github/areas.yml`: `backend`, `renderer`, `shell`,
`helper`, `contracts`, `docs`, `ci` or `deploy`. For a change spanning areas,
separate them with commas, for example `backend, renderer: Fix shared decoding`.
Describe the behaviour being changed. The body is free.

Each PR must have exactly one changelog label: `changelog:feature`,
`changelog:fix`, `changelog:docs` or `changelog:internal`. These identify the
release-note category. The current release script reads the curated changelog;
keep its entries aligned with these categories.

## Pull requests

- Link the agreed issue or discussion, or write `small fix: <evidence>` for
  the exemption above. Keep the PR to that one concern.
- Add a test with the change.
- Update the docs in the same PR when you change setup, configuration or an
  API route. API responses are decoded by clients that are not in this
  repository, so changes to them are additive — see
  [docs/API_COMPATIBILITY.md](docs/API_COMPATIBILITY.md).
- New UI text is written in English inside `t()`. Do not run `i18n:extract`:
  add the key by hand to both `renderer/locales/es/translation.json` and
  `renderer/locales/en/translation.json`, with an identity English value and its Spanish translation.

**Never commit** an API token, a provider credential, a `.env` file, a personal
file path, or your own network's addresses. Use neutral examples
(`http://your-server:8000`, `192.0.2.10`) in documentation and tests.

By contributing you agree that your contribution is licensed under the
project's licence, AGPL-3.0-or-later.
