# Working on the backend

Paths are repository-relative. Use Python 3.12 and the root virtualenv;
run `make backend` before the debug desktop client. Use an isolated data tree
as described in CONTRIBUTING.md; startup loads only the selected root's .env.

## Layout and dependencies

Start at `backend/app/main.py`, `backend/app/dependencies.py` and
`backend/app/config.py`. A feature normally has four responsibilities:
models.py (values, no ORM), repositories.py (I/O), services.py (decisions),
routes.py (HTTP). Existing domains may split these into specialized modules;
do not create empty files just to match the pattern. Compose shared instances
through DependencyContainer and FastAPI Depends.

Use `backend/app/infra/` for cross-feature machinery and `backend/app/utils/`
for lower-level helpers. Import identity gates and Principal from infra;
only main and dependencies may reach accounts internals. Do not add imports
through `backend/app/core/`, the compatibility namespace. Existing ignored
edges may only shrink.

Route acquisition into the shared library through `backend/app/domains/acquisition/`.
Its import_stage.py is the only caller allowed to publish through music/writer.py;
use the music and user-library public ports. Keep personal-library code independent
of acquisition. Access credential persistence through infra/secrets.py, not
secret_store.py.

## Files and runtime configuration

New repository methods read `self.config.base_music_dir`, not a cached
`self.base_dir`: the root can change while the process is running. Remote
clients adopt the server root; local directory controls require local-action
authorization. Configuration precedence and env pins belong in
`docs/CONFIGURATION.md`, not another env table here.

All user-controlled file access goes through `backend/app/utils/path_safety.py`:
resolve_under for segments, safe_music_subpath for relative subpaths, and
safe_open_path for existing candidates. Check resolved containment, including
symlinks; enumeration is different from serving a named file. Use
`backend/app/utils/library_paths.py` for folded album/file keys; prefer listing
mediaKey and relPath. Never substitute display album names or encode a separator
as %2F.

Use `backend/app/infra/files.py` for atomic JSON/text writes with explicit
PRIVATE/SHARED permissions. Keep persistent caches outside the swept temp tree.
Pin python-multipart in both `backend/requirements.txt` and
`backend/requirements-runtime.txt`; container uploads need the runtime pin too.

## Routes, identity and compatibility

Register routers with require_api_token; public paths are explicit exceptions.
Authorize privileged actions separately with require_owner. A write route without an
owner, account or helper gate must be listed, with its reason, as a member route. Real accounts and
synthetic owner principals differ: account-row actions return 409 for sentinels.
Never put a token/digest in identity listings; plaintext tokens are returned only
when minted. Forwarding headers must never grant loopback privileges.
The public nest name must not derive from account identity, and mDNS advertises
only a claimed server.

DELETE /api/me/library removes references and never touches files. Member
listings, ownership and file responses respect LibraryScope; outside scope looks
missing. Playlist names occupy one shared namespace even with different owners.
Acquisition linking is idempotent, and linking failure must not fail the audio
download.

Keep wire changes additive, retain status meanings and positional ownership
answers, and declare response_model before regenerating renderer types. Read
`docs/API_COMPATIBILITY.md` and `contracts/AGENTS.md` before changing a payload.

## Jobs and providers

Persist work and outcomes in `backend/app/infra/jobs/`; register feature-specific
JobKind handlers rather than another lease queue. Return progress ids immediately
after synchronous registration. ProgressTracker is a live cache; completed means
attempted, while succeeded/failed report outcomes and terminal ends polling.
Run exactly one backend worker because SSE state is process-local. Helpers dial
out through the shared claim/heartbeat/result API; old feature routes are aliases.

Dispatch through ProviderRegistry by capability and enabled order; enabled is
the user's choice, available is credential readiness. Keep disabled ids in saved
order and share the container's Deezer repository/rate limiter. Browse album
tracks come from the dedicated tracks endpoint, not the incomplete inline list.
Batch ownership queries; use display-size covers for browsing and full-size art
for embedding.

Match recordings with metadata normalization, never filename clean_title:
remasters may fold, live/remix/instrumental versions must survive. Return
STRONG/REVIEW/REJECTED and fold duplicate recordings across providers. Spotify
track ids are not recording identities. Export parse has no network/writes;
resolve proposes; only import acquires the explicit reviewed body.

## Lyrics

The release ships lyrics **sync only, with no transcription**. Optional
transcription implementation is not a promise to expose it in the release.
Sidecars beside the audio are durable content: synced .lrc, plain .txt; the
index holds provenance and the edited lock. Adopt existing sidecars and never
overwrite edits automatically. Fixed routes precede album/file routes. The
timing correction is an `[offset:]` tag (+ = sooner), written through
PUT /api/lyrics/{album}/{file}/offset, with cases in `contracts/lyrics-offset.json`.
Preserve line timestamps and unrelated tags; expectedRevision detects conflicts.

Search all enabled lyrics sources, rank defensible synced matches, and leave weak
matches pending. LRCLIB is default; Genius lyrics require explicit consent and a
key. Acquisition completion listeners enqueue work without domain cycles or
turning listener errors into failed downloads. Stems publish complete staged
results outside the music tree, validate sizes and paths, and compare source
signatures before declaring an old split current.

## Analysis

Keep heavy analysis dependencies in `helper/`. The deprecated analysis-worker
setting has no effect on helper analysis. Waveform caching and opt-in tag writing
remain configurable; their env rows already live in `docs/CONFIGURATION.md`.
This carries the analysis-related notes forward; `docs/analysis.md` describes
the current helper protocol.

Analysis is enqueued by background scans and acquisition completion, never by
reading a listing. Store per-field corrections, foreign tags and computed results
separately; precedence is correction > foreign tag > computed. Confidence affects
computed estimates only. Owner corrections use revisions; stale file signatures
drop results. Mood is computed server-side from helper measurements.

Tag writing is opt-in after the store commits. Confident computed MP3/FLAC/OGG
values carry a KROBI_ANALYSIS marker; estimates stay in the store and foreign tags
survive. Corrections overwrite without pretending to be computed measurements.
Keep provenance when moving tracks and retain corrected missing-file rows.

## Testing and updating snapshots

Use `make lint-backend`, then focused pytest tests while iterating; `make test`
runs the full suite with the 70% coverage gate in `backend/pytest.ini`.
Unit, integration, property and slow markers are available. Focused runs can
use --no-cov; they do not establish full-suite coverage.

OpenAPI acceptance uses UPDATE_API_SCHEMA=1 on the schema test; wire acceptance
uses UPDATE_WIRE_SNAPSHOTS=1 on the wire test. Run from backend with the root
virtualenv, review every snapshot diff and regenerate via `npm run api:generate`.
Do not accept a removed field merely to make tests green.

## What guards these rules

| Rule | Guard |
|---|---|
| Supported Python and dependency boundaries | `backend/pyproject.toml`; `make lint-backend` |
| Domain file layout and isolated development data | Not enforced yet |
| Runtime roots and safe paths | Configuration/route tests; `backend/tests/unit/test_path_safety.py`; `backend/tests/unit/test_playlist_path_safety.py`; `backend/tests/unit/test_library_paths.py`; blanket cached-root guard not enforced yet |
| Atomic writes, cache placement and upload dependency pins | `backend/tests/unit/test_dependency_pins.py`; universal writer/cache policy not enforced yet |
| Route authentication, principals and scope | Auth, identity-route and member-library integration tests; `backend/tests/unit/test_infra_identity.py`; `backend/tests/unit/test_library_scope.py`; `backend/tests/architecture/test_member_routes.py` (every ungated write is a listed member route) |
| Acquisition publication and account links | Import-linter contracts; acquisition behavior suites in `backend/tests/unit/` |
| Shipped schemas and response bodies | OpenAPI, response-contract and wire-snapshot integration tests; deliberate compatibility review not enforced yet |
| Durable jobs, leases and one-worker runtime | `backend/tests/unit/test_jobs_ledger.py`; `backend/tests/unit/test_jobs_queues.py`; `backend/tests/unit/test_helper_protocol.py`; worker-count guard not enforced yet |
| Provider dispatch and recording matches | Provider, metadata and Spotify-export suites in `backend/tests/`; live-provider quotas not enforced yet |
| Lyrics, stems and edited-sidecar protection | Lyrics/stems unit and integration tests; `contracts/lyrics-offset.json` |
| Analysis precedence, signatures and tag provenance | `contracts/analysis.json`; analysis unit and integration suites in `backend/tests/` |
| Full-suite coverage | 70% gate in `backend/pytest.ini` |
