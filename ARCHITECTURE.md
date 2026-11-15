# Architecture

Flipspin is a self-hosted music server with a desktop client. The FastAPI server
owns the shared audio catalog, accounts, personal library references and jobs.
A Tauri shell supplies native capabilities to a React renderer; it can connect
to another machine or host a bundled server. Optional helper processes perform
expensive audio work by claiming jobs from the server. Phone clients live in
other repositories, and OpenSubsonic clients use the same catalog. The server
and clients can be upgraded independently, which makes the wire a lasting boundary.

This is a map for finding the code and understanding its constraints. Area
AGENTS.md files describe how to change it; feature details belong in docs or
beside their implementations. Paths below are relative to the repository root.

## Design principles

- **Durable jobs.** Downloads, imports and helper work are recorded in a SQLite job ledger. Queued work resumes after a restart, interrupted work is marked as interrupted, and each item reports its own outcome.
- **Track identity across catalogs.** Matches use ISRC and MusicBrainz recording IDs, with a normalized title and duration as fallback. Each match is graded strong, review or rejected, so a live take is never merged with the studio recording.
- **Stable wire.** The OpenAPI schema and full response bodies are snapshot-tested. Shared contract cases in [`contracts/`](contracts/) are run by the server, the desktop app and, for most rules, the phone apps.
- **Secure by default.** Every route requires a token unless it is explicitly public. Device tokens are stored hashed and can be revoked one by one. The first account is claimed with a setup code, and media tokens never appear in URLs on the desktop.
- **Tested.** More than 6,000 automated tests (Python, TypeScript and Rust), import-boundary checks, and a clean Docker install on every CI run. A release publishes only when every job passes. The server image ships for amd64 and arm64 with an SBOM and build provenance.

## Codemap

### Server: backend/

`backend/app/main.py` is the composition root: startup, routers and shutdown.
`backend/app/dependencies.py` builds the shared DependencyContainer and exposes
FastAPI dependency functions. `backend/app/config.py` owns ConfigManager.
Repositories and services share that configuration rather than constructing
private copies of runtime settings.

`backend/app/domains/` groups features by responsibility. The usual shape is
models.py for values, repositories.py for I/O, services.py for decisions, and
routes.py for HTTP. Some domains split these responsibilities across more files.

- `backend/app/domains/music/` scans and serves the physical catalog.
  repositories.py reads tracks, ownership.py matches catalog recordings,
  library_scan.py coordinates scanning, and analysis_repository.py stores analysis.
  public.py exposes a narrow catalog port; writer.py publishes acquired files.
- `backend/app/domains/user_library/` stores account references to that catalog.
  store.py owns rows, scope.py restricts visibility, and public.py exposes linking.
- `backend/app/domains/acquisition/` coordinates request, matching, fetching,
  import and account linking. services.py drives the durable pipeline;
  import_stage.py is the caller allowed to publish household audio.
- `backend/app/domains/downloads/` holds download adapters and legacy endpoints.
  `backend/app/domains/playlists/` owns playlist files and Spotify export parsing.
- `backend/app/domains/metadata/` owns recording normalization, matching and
  provider resolution. `backend/app/domains/browse/` exposes catalog pages.
  Browse identity is a provider plus its id; a web URL is only an affordance.
- `backend/app/domains/accounts/` owns users, device tokens, claim and sign-in.
  Credential design and recovery are in [docs/security.md](docs/security.md).
  `backend/app/domains/system/` exposes health, library location and settings.
  `backend/app/domains/server/` supplies server administration.
- `backend/app/domains/lyrics/` manages sidecars and sync jobs;
  `backend/app/domains/stems/` stores split-song manifests and audio.
  `backend/app/domains/helpers/` exposes the shared helper protocol.
  `backend/app/domains/jobs/` exposes durable job history.
- `backend/app/domains/subsonic/` adapts the catalog for OpenSubsonic clients.
  `backend/app/domains/dashboard/` assembles home-page rows;
  `backend/app/domains/transfers/` sends audio to VLC.

`backend/app/providers/registry.py` defines provider kinds, capabilities and
ordering. adapters.py connects implementations; persistence.py stores choices.
Consumers dispatch by declared capability and enabled order. The dashboard
shares visibility controls but keeps its own composed cache.

`backend/app/infra/` supplies identity ports, progress, logging, atomic files,
configuration provenance, secrets and durable jobs. identity.py defines Principal
and request gates; accounts supplies token resolution at composition time.
security.py handles encrypted secret storage, a different responsibility from auth.
secrets.py is the public secrets boundary; secret_store.py is its persistence.

`backend/app/infra/jobs/ledger.py` records jobs and item outcomes in SQLite.
queue.py implements helper leases; kinds.py lets features register job handlers.
`backend/app/infra/progress.py` keeps the disposable live progress/SSE cache.
See [Jobs and helper leases](docs/jobs.md) for ledger attempts, lease fencing,
requeue and helper process lifetime.
`backend/app/core/` is a temporary compatibility namespace for extensions.
`backend/app/utils/path_safety.py` validates paths;
`backend/app/utils/library_paths.py` maps library keys to safe paths.

`backend/tests/` contains unit, integration and property tests. The committed
OpenAPI snapshot is `renderer/api-schema.json`; response fixtures shared with
clients are in `contracts/wire/`.

### Desktop shell: src-tauri/

`src-tauri/src/main.rs` starts the app; `src-tauri/src/lib.rs` builds it,
registers commands and the media scheme, and shuts down child processes.
`src-tauri/tauri.conf.json` defines bundle resources and window configuration.

`src-tauri/src/desktop/mod.rs` holds DesktopState and composes native services.
nest.rs and nest_process.rs choose, adopt and start a server; handshake.rs
validates identity; discovery.rs browses mDNS; connection.rs selects addresses.
prefs.rs persists metadata; credentials.rs owns OS-vault/session token storage
and explicit file opt-in. bridge.rs dispatches typed channels.
proxy/ guards JSON and media forwarding; custom_headers.rs scopes proxy secrets
and HTTP clients to an origin. downloads.rs saves local copies,
and player.rs relays the separate player window's state.
`src-tauri/crates/krobi-offline/` owns offline storage, pins, snapshots and
transfer policy; `src-tauri/src/desktop/offline/` adapts it to shell authority.

`src-tauri/src/lyrics/` installs and supervises the helper environment.
`src-tauri/src/worker_tray.rs`, `src-tauri/src/sleep.rs` and
`src-tauri/src/keep_awake.rs` handle the helper's desktop lifetime.
`src-tauri/src/placement.rs` manages window placement.

### Interface: renderer/

`renderer/src/main.tsx` installs the native bridge, then auth interceptors,
then mounts Gate and App. `renderer/src/desktop/tauri.ts` translates typed
channels and supplies the legacy desktopAPI compatibility object.

`renderer/src/` is one feature tree: player, library, albums, playlists,
browse, acquisition, downloads, lyrics, stems, settings, onboarding, auth,
pairing, offline, analysis, uploads and visualisers own their screens, stores,
helpers and tests together. Existing @ts-nocheck files are being typed in place;
there is no separate generation tree.

`renderer/src/shell/App.tsx` composes providers and pages; shell/pageTable.ts
lists pages, shell/layout holds the frame, and shell/routeStore.ts owns hash
navigation. shell/Gate.tsx coordinates server choice and authentication;
`renderer/src/connection/` owns reachability and connection details. Browse
has a separate entity stack over the hash route. Stores that must survive
navigation use module singletons and useSyncExternalStore.

`renderer/src/state/` holds app-wide contexts and stores. Shared non-UI helpers
and the IPC channel contract live in `renderer/src/lib/`. Backend calls use
`renderer/src/api/client.ts` with generated OpenAPI types, `renderer/src/data/http.ts`
and data/hooks query adapters. `renderer/src/bridge.ts` is the native entry
point. `renderer/src/test/` holds test setup. Only deprecated plugin forwarding
files remain at the former generation paths until after v0.2.

`renderer/src/player/engine/` owns the output timeline and playback position.
Its persistent decoder Worker sniffs MP3, FLAC, Ogg Opus/Vorbis and WAV, resamples
to the context rate and feeds bounded PCM into one AudioWorklet output. M4A/AAC
and ALAC use one budgeted native AudioBuffer, chunked into the same output.
Trimmed track boundaries are spliced on that clock. Seek uses format metadata
or frame/granule bisection. Rings hold at most two tracks and thirty seconds each.
PlaybackController drives the retry/state contract through an engine port;
AudioPlayerContext still owns queue, history and now playing. StemPlayer is a
budgeted source with mix controls, sharing the engine's clock and output.
`renderer/src/stems/audioGraph.ts` owns the single context, analyser, one
levelling gain and output volume. ESLint and the baseline ratchet enforce output
ownership. No media element playback path remains. The UI compatibility name
`audioRef` refers to an engine port, not a DOM element.

`renderer/src/ui/` is Flipspin's UI kit: scoped surface tokens, React primitives,
modal layers, motion and missing-value vocabulary. styleGuard.test.ts checks
the style ratchet against style-baseline.json. `renderer/src/styles/` holds
the broader app styling. `renderer/src/plugins/` is generic extension wiring; `renderer/src/plugins/host.ts`
exports stable host imports for lazy plugin screens and their tests.
`renderer/src/i18n.ts` configures translation; `renderer/locales/` holds catalogs.

### Compute: helper/

`helper/pyproject.toml` separates the base package from engine, stems,
analysis and optional transcription dependencies.
`helper/krobi_helper/cli.py` is the krobi-helper entry point;
agent.py claims work, downloads inputs, supervises children and posts results.
protocol.py owns JSON-lines stdout messages; acceleration.py detects capability.
`helper/krobi_helper/kinds/` separates lyrics alignment, stems and analysis.
`helper/krobi_helper/plugins.py` discovers optional worker extensions.
`helper/compat/` retains the previous package name for one release.
`helper/tests/` exercises protocol and pure pipeline behavior without model downloads.

### Shared rules and supporting directories

`contracts/` contains language-neutral JSON cases. `contracts/wire/` contains
whole server responses consumed by client decoder suites. These are examples
with executable expectations, not a second generated type system.

`docs/` holds public feature, configuration and operations references.
`deploy/` holds install scripts, systemd configuration and Unraid packaging;
`docker-compose.yml` and `backend/Dockerfile` define the server container.
`scripts/` holds schema generation, packaging and verification drivers.
`resources/` supplies icons and starter-content policy.
`.github/` holds repository automation. `Makefile` is the command entry point;
`package.json` defines frontend, schema and packaging scripts.

## Invariants and boundaries

**Invariant:** infra imports no new domain code. Composition points inward:
main → features/providers/dependencies → infra → utils. Existing upward edges
and domain cycles are explicit exceptions that may only shrink. Features use
infra identity ports rather than accounts internals; new backend code never
imports the core compatibility namespace.

**Invariant:** only acquisition's import stage publishes acquired household
files. Personal library references do not depend on acquisition. Secret
persistence is reachable only through the secrets boundary.

**Invariant:** a new route is closed by default. Router registration attaches
authentication; public paths require an explicit exception. Account authorization
is separate from authentication, and forwarded headers cannot confer loopback
privileges.

**Invariant:** the wire is additive only because shipped clients decode it
independently of this tree. Keys, types, status meanings and positional ownership
answers remain stable. Shared behavioral answers live in contracts/*.json.

**Invariant:** track keys retain exactly two segments. Nested folders fold with
∕ (U+2215), never an encoded slash; root tracks use the reserved root album key.
Display album names are not directory identities.

**Invariant:** deleting a personal library row never deletes shared audio.
DELETE /api/me/library only removes references; filesystem deletion is a separate
operation. Members see their own scope, and synthetic owners have no account
rows.

**Invariant:** the backend runs one worker. Durable jobs survive restarts, but
live progress is per-process memory; multiple workers split producers from SSE
readers. Deployment commands pin one worker. A general runtime guard is not
enforced yet; progress and recovery behavior have job/progress tests.

**Invariant:** heavy ML lives only in helper/. Helpers dial out, claim leased
jobs, heartbeat and publish under the current lease. The server never connects
back to a helper. A nest fallback still invokes a separate helper program.

**Invariant:** renderer features talk to the backend through generated OpenAPI types
and to the shell through `renderer/src/bridge.ts`. Generated types are never hand-edited.
Settings section ids, saved hashes, storage keys and IPC channel names remain
stable across renderer file moves.

**Invariant:** English is the i18n source key. Add identity English values and
Spanish translations by hand to both catalogs; do not run `i18n:extract`.
Translate at render or call time; module-scope translation would freeze the
boot language.

**Invariant:** there is no production browser client in the server image, no
cloud identity control plane, and no built-in editor, decomposition or CD-burning
domain. Optional trusted plugins extend generic host contracts. Their code and
schemas remain outside the host. Clean-host plugin tests cover registration;
the absence of future features is not enforced yet.

## Cross-cutting concerns

Filesystem input crosses `backend/app/utils/path_safety.py` before access.
Repositories read the current ConfigManager music root. Atomic writers choose
private versus shared permissions explicitly. Request logs omit URL queries
because media players and SSE sometimes carry query credentials.

JSON and multipart use the Rust backend proxy; media uses the guarded
krobi-media scheme with credentials and origin-scoped custom headers added
in Rust. Desktop progress polls snapshots through the same proxy. Browser
development uses HTTP fallbacks.
Remote mode must never send a client-local library path to the server.

Every modal uses ModalLayer or its shared dismissal/presence machinery.
Motion uses named tokens and honors reduced motion; missing values use Missing.
The renderer style guard enforces numeric-duration bans and ratchets raw colors,
z-index values and bare missing-value dashes. Accessibility behavior has modal tests.

Lyrics sidecars are the durable content; the index records provenance and edits.
The release ships lyrics sync only, with no transcription. Timing correction
is an [offset:] tag (+ = sooner), written through
PUT /api/lyrics/{album}/{file}/offset; `contracts/lyrics-offset.json` fixes its meaning.

## What guards these rules

| Rule | Guard |
|---|---|
| Backend dependency direction, acquisition writer and secrets boundaries | Import-linter contracts in `backend/pyproject.toml` |
| Authentication and principal authorization | `backend/tests/integration/test_auth.py`; `backend/tests/unit/test_infra_identity.py` |
| Additive wire shapes and shared behavior | OpenAPI, response-contract and wire-snapshot suites in `backend/tests/integration/`; consumers listed in `contracts/AGENTS.md` |
| Library keys, scope and reference-only deletion | `backend/tests/unit/test_library_paths.py`; `backend/tests/integration/test_member_library_scope.py` |
| One backend worker | Deployment commands pin one worker; general runtime guard not enforced yet |
| Helper-only ML and leased results | No-ML import contract; `backend/tests/unit/test_helper_protocol.py`; `helper/tests/test_helper_api.py` |
| Renderer entry points, styles and native bridge | TypeScript, ESLint, style and bridge tests; exclusive entry-point use not enforced yet |
| Translation at call time | i18n lint/status and renderer tests; module-scope ban not enforced yet |
| Generic extension host and excluded product domains | Clean-host plugin tests; absence of future features not enforced yet |
