# Developer guide

How the code is laid out, and the rules in it that are easy to break by
accident. Setup and commands are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## The three parts

```
backend/     FastAPI server (Python 3.12) — the product
src-tauri/   Tauri 2 shell (Rust): windows, backend lifecycle, request proxy
renderer/    React 19 + Vite + TypeScript UI, loaded by the shell's webview
helper/      optional lyrics/stems engine (separate Python; MLX, CUDA or CPU)
deploy/      systemd unit and environment template
```

In development the webview loads `http://localhost:5173` (Vite, fixed port);
packaged builds load the bundled `build/`. For renderer-only development, run
`VITE_API_BASE_URL=http://localhost:8000 make frontend` (optionally set
`VITE_API_TOKEN`). This uses HTTP without native setup or sign-in; native
controls require Tauri. The server image contains only the API.

## Server (`backend/app/`)

Each feature is a domain with the same four files:

```
domains/<name>/
  models.py        dataclasses (no ORM)
  repositories.py  filesystem / JSON / external API I/O
  services.py      business logic, calls repositories
  routes.py        FastAPI router, calls services
```

Feature domains: `music`, `playlists`, `downloads`, `metadata`, `browse`,
`lyrics`, `dashboard`.
Three more hold what every client shares: `accounts` (users, tokens, devices, sign-in and the first-owner claim),
`user_library` (each account's own rows over the shared catalog) and `system`
(status, health, the music directory, logs, runtime settings).

`app/infra/` is the infrastructure layer: progress tracking,
logging, CORS, secret storage, the instance id and the server's name
(`instance.py`), the LAN advertiser (`discovery.py`), throttling. The provider
registry is `app/providers/`; small helpers are in `app/utils/`.

Services and repositories are built once by `DependencyContainer`
(`app/dependencies.py`) and injected with FastAPI's `Depends()`. The shared
`ConfigManager` is at `request.app.state.config`.

- ⚠ **Repositories must read `self.config.base_music_dir`**, not a copy taken
  at construction — the library directory can change at runtime
  (`POST /api/set-basedir`).
- ⚠ **All filesystem access from user input goes through
  `app/utils/path_safety.py`** (`resolve_under`, `safe_music_subpath`,
  `safe_open_path`).
- ⚠ **Routes are closed by default.** Every router is registered in
  `app/main.py` with `Depends(require_api_token)`; the few public paths are an
  explicit allowlist in `app/infra/identity.py`.
- ⚠ **Response shapes are public contracts** — see
  [API_COMPATIBILITY.md](API_COMPATIBILITY.md).

### Accounts and identity

- `app/infra/identity.py` — caller values, request gates and identity query ports.
- `app/domains/accounts/identity.py` — accounts, devices and token digests in
  `~/Krobi/users.json`. `app/infra/security.py` is a different thing: encrypted
  storage for provider secrets.
- `app/domains/accounts/claim.py` — `POST /api/claim`, the first-owner claim.
  The claim may also name the server (`nestName`).
- `app/domains/accounts/routes.py` — sign-in, devices, account management.
- `app/domains/user_library/store.py` — per-account library rows over the one shared
  catalog on disk. A track's identity is `"<albumKey>/<fileKey>"` — the album
  folder for a flat library, `Artist∕Album` (U+2215) for a nested one; see
  `app/utils/library_paths.py`.
  `DELETE /api/me/library` removes the caller's row and never touches a file;
  deleting a file for everyone is a different route.

### The nest

The desktop app calls the server **the nest** ("el server"). That is UI copy only:
code, API, unit and folders keep `server` / `krobi-backend`.

- `instance.json` carries an optional `name` beside the `instanceId`, written
  read-modify-write so a rename never drops the id. `GET /api/status` reports it
  (default plain `Nido`, never an account or the hostname — that body is public);
  the owner changes it with `PUT /api/server/name`.
- `app/infra/discovery.py` advertises `_krobi._tcp` over mDNS (TXT: `instanceId`,
  `version`, `name`) **only once the server is claimed**, refreshed after the
  claim and after a rename. It is skipped with `KROBI_ADVERTISE=false`, when the
  bind is loopback, and under pytest. Nothing in it may fail a boot or a claim.
- `python -m app` (and the packaged `run_standalone.py`) honours `--host` and
  `--port` and exports them as `KROBI_BACKEND_HOST` / `KROBI_BACKEND_PORT`.

The caller is available to a handler through the `current_principal`
dependency. Synthetic principals (the legacy shared secret, a loopback caller)
are owners but have no account row, so per-account routes answer `409` for them.

### Long-running work

Downloads, imports and lyrics passes are non-blocking. A route mints
a `progress_id` with `ProgressTracker` (`app/infra/progress.py`), starts the work
in the background and returns immediately; clients follow
`GET /api/download-progress-stream/{id}` (SSE) or poll. `completed` counts
items attempted; `succeeded` and `failed` say how they went.

⚠ The tracker is process memory, so the server must run with **one worker**.

### Providers

Metadata, lyrics, acquisition and dashboard sources register in one
`ProviderRegistry` (`app/providers/`). The order per kind is the escalation
order, set by the user in Settings → Sources and persisted to
`~/Krobi/providers.json`. A provider is asked only for capabilities its
descriptor declares. `enabled` (the user's choice) and `available` (credentials
actually present) are different things.

### Track identity

Catalog matching (`domains/metadata/normalization.py`, `matching.py`,
`resolution_service.py`) returns STRONG / REVIEW / REJECTED, never a boolean,
and prefers a wrong "no" over a wrong "yes". A Spotify track id is never a
dedupe key; the backbone is the MusicBrainz recording id, with a normalized
artist+title key plus close duration as the fallback. In normalization, a
remaster is the same recording, while live, remix, instrumental and radio edit
are not — which is why `downloads/utils.py::clean_title()` (right for file
names) must not be reused there.

### Lyrics

Lyrics live as sidecar files beside the audio — `Song.lrc` when synced,
`Song.txt` when plain — so any player can read them. `~/Krobi/lyrics.json` only
records where each came from and whether a person edited it; an edited lyric is
never overwritten automatically. The optional engine in `helper` runs as
a subprocess on Apple Silicon, or as an agent on a Mac that claims jobs from a
remote server.

## Desktop shell (`src-tauri/src/`)

`main.rs` (entry), `lib.rs` (plugins, commands, the media URI scheme),
`desktop.rs` (state, backend lifecycle, commands, URL guards and their tests),
`lyrics.rs` (the lyrics engine and agent on the Mac side).

- **Choosing the server** (the nest): `KROBI_BACKEND_URL` (locks the choice) →
  the saved `serverMode` (`"local"` or `"remote"`, written by `server:use`) →
  migration for installs older than the chooser (a saved `backendUrl` means
  remote; a `"local"` credential or an existing `~/Krobi` means local) →
  otherwise **`unchosen`**: a fresh install probes and spawns nothing, and the
  renderer asks "¿Dónde está tu server?". The shell probes `GET /api/status` and
  only accepts a server that answers `app: "krobi"`; a local one already running
  is adopted rather than duplicated (any Flipspin server on the port is adopted —
  `instanceId` is not compared).
- **Spawning**: packaged builds in local mode start the bundled server if
  nothing answers on port 8000, with `--host 0.0.0.0` (so other devices can
  reach this computer's nest) and `KROBI_REQUIRE_SETUP_TOKEN=true` (so they
  cannot claim it). `server:local-setup-token` reads `~/Krobi/setup-token` for
  the local window only. **Debug builds never spawn it** — run `make backend`.
- **The LAN**: `ServerStatus.lanUrl` is this computer's LAN address in local
  mode, used for the pairing QR (`baseUrl` is loopback there).
  `server:discover` browses `_krobi._tcp` for ~2 s and confirms each answer with
  its handshake; `app:get-device-name` names this computer for device labels and
  the nest's name.
- **Credentials** are stored by Rust in the app-data directory, keyed by server,
  and announced to every window with an `auth:changed` event.
- **Desktop identifier migration.** `app.flipspin.desktop` copies the previous
  `app.krobi.desktop` store only when the destination is empty. The migration
  plugin runs before logging, state loading and webview creation. It copies
  preferences, credential metadata, offline files and the WebKit store, verifies
  copied vault items, and rebases managed offline paths in the copied database.
  Pending/completed markers make interruption retryable and completion logged
  once. Originals are retained. See [upgrading](upgrading.md#desktop-rename).
- **Two transports.** JSON requests go through the `backend_request` command,
  which only forwards to the configured server and adds the bearer token. Media
  goes through the `krobi-media://` URI scheme, which streams `GET`/`HEAD` under
  `/api/media` with the token added in Rust — so under Tauri no token appears in
  a media URL.

## Renderer (`renderer/`)

React 19, Vite, Tailwind 4, TypeScript. One feature tree under `renderer/src/`:
player, library, albums, playlists, browse, downloads, lyrics, stems, settings,
onboarding, auth, pairing, offline and viz keep their screens, stores and tests
together. `renderer/src/shell/` composes App, routes, the page table and layout;
`renderer/src/state/` holds app-wide contexts and stores, and `renderer/src/lib/`
holds shared non-UI helpers. `renderer/src/ui/` owns shared controls.

Backend calls use generated OpenAPI types in `renderer/src/api/` and TanStack
Query adapters in `renderer/src/data/`; native calls use `renderer/src/bridge.ts`.
Do not hand-write response interfaces: fix the FastAPI route's response_model
and regenerate with `npm run api:generate`. Existing @ts-nocheck files are being
typed in place; do not add the directive to new files. Former generation paths
contain only plugin compatibility re-exports through v0.2.

`main.tsx` installs the native bridge first, then the global `fetch` /
`EventSource` interceptors (`src/lib/apiAuth.ts`, which add the current token to
every backend request), then renders `<Gate><App/></Gate>`. `Gate` first asks
the shell where the nest is: `unchosen` opens the wizard’s Nest step
(`onboarding/NestStep.tsx`: discovered nests, this computer, a setup link,
or a typed address). "Change nest" uses that same step. A leftover `~/Krobi`
folder alone does not select local mode; an explicit local choice reuses it.
A nest this computer is still starting is waited for.
Then it reads the `/api/status` handshake and shows account creation (on an
unclaimed server), sign-in, a "server unreachable" screen with a retry, or the
app; after a claim on this computer, "Your music" asks once for the music folder.
Once the nest is known the handshake fails open: if it errors, the app still
loads.

The first-run screens and Settings use **krobi-ui**, Flipspin's own UI kit at
`renderer/src/ui` (AGPL-3.0, like the repository). Its tokens are scoped to
`.krobi-setup` and `.krobi-settings`; the wizard uses the glass profile and
Settings bridges the app palette through `settings.css`. Edit the kit here with
its consumers, keeping only the components and styles Flipspin uses. See its
`README.md` for the load order and visual verification driver.

State in the older tree is React context (provider order in `App.tsx` is
load-bearing); a few stores that must outlive a view unmounting are module
singletons read with `useSyncExternalStore`. There is no router library in use:
`App.tsx` switches on an `activePage` string, with a navigation stack on top for
catalog pages.

### Interface language

`react-i18next`, catalogs in `renderer/locales/{es,en}/translation.json`.
**English is the source and the key**: write `t('Save')`, not a slug. The
language follows the system and can be changed in Settings → General.

- New strings: write them in English inside `t()` and add both catalog lines
  by hand: identity English and the Spanish translation. Do not run
  `i18n:extract`; the extractor remains unused.
- Plurals use `count`: `t('{{n}} songs', { count, n })`.
- Never call `t` at module scope; wrap static tables with `msg()` and translate
  where rendered.
- `npm run i18n:status` counts missing translations; `npm run i18n:lint` lists
  hard-coded strings.

## Configuration and files on disk

Everything defaults under `~/Krobi/`; every path is overridable. The full list
is in [CONFIGURATION.md](CONFIGURATION.md).

### Import direction and identity

`make lint-backend` runs Ruff and `lint-imports`; `make lint` includes it, and CI
runs the same backend target. Install the pinned dev dependencies from
`backend/requirements.txt`. For a worktree using another checkout's virtualenv,
pass `VENV=/absolute/path/to/.venv` to make.

The import layers are `app.main` → feature domains, providers and dependency
composition → `app.infra` → `app.utils`. Providers share the feature layer:
their adapters dispatch into domains, while domain services use the registry.
The existing cycles between domains and upward imports from helper/job dispatch
are recorded as exact `ignore_imports` edges with reasons in
`backend/pyproject.toml`. This baseline may only shrink. Removed imports fail as
stale ignores until their entries are removed. Helper and job dispatch exceptions
are deferred to a later change; they do not authorize new infra-to-domain imports.

Features obtain `Principal`, sentinel principals and request gates from
`app.infra.identity`. Accounts owns account/device mutation and token storage;
`main.py` registers the per-request token resolver supplied by `dependencies.py`.
The infra protocols expose only the identity queries needed by request gates,
status, Subsonic and playlist migration. Only `main.py` and `dependencies.py`
may import accounts from outside that domain. The old
`app.domains.accounts.identity` values and `app.domains.accounts.auth` gates
remain re-exports.

### Request authentication

Per-device tokens are accepted independently of the legacy shared-secret setting.
An unresolved presented token is rejected even on loopback. With a shared secret
configured, every client must authenticate. Without one, a request carrying no
token may use the loopback owner; remote access requires the explicit
unauthenticated-remote setting. The request's client address supplies the local
signal because a wildcard bind also serves legitimate local clients. Forwarded
headers cannot grant loopback authority. Configuring a secret removes the local
bypass so other local users do not inherit access.

Authentication records a principal; privileged and machine-local actions have
separate gates. A token authorizes API access but does not make a GUI action on a
remote server useful. Local actions therefore require loopback unless explicitly
enabled remotely. Public exceptions are listed in `infra/identity.py`; the root
health response is declared directly on the app rather than a protected router.

The public status response advertises password sign-in only when an account can
actually use it. This is a boolean, never an account count or identity listing.
Clients with token-only accounts need pairing rather than an unusable login form.

### Secret attempt throttling

Claim and sign-in each use an independent global in-memory bucket. Per-address
buckets can be bypassed by rotating addresses, and forwarded addresses are not
trusted identity. Per-account buckets reveal whether a username exists and allow
targeted lockouts. A global bucket trades these problems for the possibility of
delaying all new sign-ins during an attack. Existing device tokens remain usable,
so the delay affects device enrollment rather than ongoing library access.
Restart clears the window; an actor able to restart the server already controls
the machine.

### Server discovery and addresses

`instanceId` identifies a data directory across process restarts, upgrades and
port changes. It lets clients recognize a running server and avoid starting a
second writer against the same data. It is public and carries no library data.
Updates to the optional name and external URL preserve it under the same lock.
The public name is chosen explicitly and defaults to `Nido`; it never derives
from an account or hostname.

mDNS is a LAN convenience. It does not replace a configured address and normally
does not cross a routed VPN. Advertising is suppressed before claim, for a known
loopback bind, when disabled, and during tests unless a fake transport is injected.
An unknown bind cannot be used to suppress advertising. Discovery runs off the
request path and its errors cannot prevent startup or claim.

Authenticated network discovery combines LAN addresses, Tailscale addresses and
an owner-configured HTTPS origin. MagicDNS lookup is optional, has a two-second
timeout and a one-minute cache; failure leaves the IP usable. These deployment
details stay off the public handshake. Alternate addresses identify transports;
clients validate the same instance id and retain their established credential key.
External origins reject credentials, paths, queries, fragments and plain HTTP;
the shared normalization cases are in `contracts/remote-access.json`.

### Personal library persistence

Personal rows reference shared audio and add membership, likes, offline intent
and listening counters. Their key is `(user_id, rel_path)`, using the same
album/file identity as media routes. A rename requires repointing references.
URL-shaped paths are rejected rather than silently stripped: accepting a query
could persist credentials and produce an identity no file lookup can match.

The store uses an `RLock` for threaded routes and atomic private writes because
listening data is sensitive and a partial table is unusable. Missing or corrupt
input logs and loads an empty table rather than preventing startup. Membership,
likes, offline intent and plays creating a row flush immediately. Increments to
existing play counts coalesce for `PLAY_FLUSH_SECONDS`; any intervening write
includes them. A hard crash can lose only those deferred counters. `flush()`
forces them to disk.

Routes derive the user from the principal, never a body-supplied user id. Members
can manage their own rows; history export additionally requires an owner account.
Missing files are batch results rather than whole-request failures. Synthetic
principals have no account row and receive 409 on personal-library routes.
Ownership answers retain input positions, including duplicates; catalog ownership
is a separate fuzzy query, while personal ownership checks exact path membership.

Acquisition links existing dedupe hits immediately and links new files after
publication. Linking errors report an outcome without failing acquisition: the
audio is already useful, and a later membership request or dedupe hit can repair
the reference. Synthetic principals skip linking without warnings. Only paths
that can resolve to a library key are linked; no truncated path may be invented.

### Playlist authorization

Members access their own playlists; owners administer all playlists, including
ownerless files. Member privacy applies against other members. Names remain one
shared namespace because both the route and filename identify a playlist by name.
A name collision returns 409 without disclosing the owner or contents. Access to
an existing unauthorized playlist returns 403; an absent playlist returns 404.
Name existence is already observable through creation conflicts.

The ownership migration writes its one-shot marker before stamping files. A crash
can leave some files ownerless, which retains the same owner-only access policy.
Repeating the migration based on ownerless files could reassign later user data.
Stamping edits JSON atomically without resaving through the general playlist
writer, which would change modification dates and reorder recent playlists.
Explicit account transfer may replace an expected previous owner. AppleDouble
companions are skipped on listing because they match JSON globs but contain
binary metadata; a read operation does not delete them.

### Provider preferences

The registry defines installed providers and declared capabilities. Preferences
only order and disable those ids; they do not define executable providers. The
effective order retains registered saved ids, then appends new registrations.
Unknown saved ids are ignored for dispatch and retained for future availability.
Corrupt reads fall back to defaults; writes replace the preference file atomically.
Explicit consent is separate from enabling and is never inferred from old files.

Consumers dispatch by declared capability rather than method presence. Enabled
records user intent; available records runtime credential readiness. Keeping
these separate preserves preferences when credentials are missing. Metadata and
streaming must retain an enabled provider because they are required for import
and acquisition. Lyrics and dashboard may be fully disabled. Production consumers
use the container's shared registry so settings changes affect every caller.

### Recording resolution

Resolution walks enabled providers in order and stops on STRONG, reserving slow
provider budgets for ambiguous requests. Repeated requests use an in-process
normalized-key cache. Duplicate recordings within and across providers are folded
before scoring: otherwise the same recording becomes its own runner-up and loses
the required winner margin. Earlier providers retain their row while later ones
fill missing identifiers. Folding requires normalized identity and close duration.

Identifiers make a candidate identifiable, not automatically correct: export
requests usually have no recording id to compare. Text, duration and qualifiers
establish a match; an identifier and a sufficient runner-up gap permit automatic
acceptance. Provider failures degrade to remaining sources with explanations.
Batch resolution keeps one rejected result for a failed track, continues other
tracks, checks cancellation before each item and tolerates progress callback
errors. Cancellation returns a shorter result list. A retry can reuse cached
results until the backend process restarts.

YouTube upload titles require artist/title extraction and removal of upload
labels before the shared matcher runs. These conventions stay out of the general
normalizer. Live, remix, instrumental and other recording qualifiers survive every
cleanup rule. Videos have no ISRC or MBID, so selection accepts a non-vetoed REVIEW
result, including an ambiguous pair of equivalent uploads. A qualifier or duration
veto still rejects the result. Post-download duration verification flags a
surprising file rather than deleting it: duration mismatch suggests the wrong
recording but does not establish corrupt audio.

### Provider request budgets

Deezer quota failures can arrive as HTTP 200 with error code 4, so body inspection
is required. The approximate 50 requests per five seconds figure is a historical
measurement, not a published guarantee. Pacing and bounded backoff protect a
budget shared with other clients on the same public address. Transport failures
are not quota retries.

Search results may carry ISRC inline. Missing identifiers trigger bounded
`/track/{id}` enrichment for the top results, defaulting to three; zero disables
it. This preserves automatic acceptance when search omits identifiers. Failed
enrichment leaves a reviewable candidate. Album browsing uses the dedicated
`/album/{id}/tracks` response because inline album tracks can omit ISRC, track
position and disc number. Two album requests provide identifiers without
per-track enrichment.

MusicBrainz requests use an attributable application User-Agent and a shared
repository limiter paced at one request per second. Rate failures can affect all
requests from an address; 503 can also represent service load, so bounded backoff
is useful. Long batches therefore require progress and cancellation. Forks should
configure their own contact identity.

YouTube acquisition is the external source plugin `flipspin/flipspin-source-youtube`;
its yt-dlp version and player-client choice belong to that plugin.
Browse artwork prefers 500-pixel images for high-density cards to limit payload
cost; acquisition upgrades embedded artwork to the full-size variant.

### Dashboard caching

Dashboard requests multiply with every client opening the app. A serialized,
disk-backed six-hour cache bounds refresh traffic across restarts while still
showing daily catalog changes. Degraded snapshots use a shorter retry TTL so a
temporary failure does not remain for six hours. Refresh failures preserve each
row's cached items as stale; an uncached failure returns empty rows with errors.

One chart response supplies tracks, artists and playlists. New releases uses a
separate request and falls back to editorial selection when releases is empty.
Sharing the chart call couples those rows' failures but avoids extra traffic;
the service cache provides row-level recovery. Provider errors must propagate to
that service rather than becoming indistinguishable empty successes.

Artist recommendations use deterministic top and recent library artists with a
bounded request budget. Only exact normalized artist-name matches are accepted;
a collaboration may retry its primary credit. Album exclusion compares normalized
titles across known artist spellings, folding packaging noise while retaining
live qualifiers. It runs again when cached rows are served so an acquisition
disappears immediately. A quota error ends the refresh walk.

### Spotify export import

Privacy exports supply playlist requests without requiring playlist API access.
Parsing accepts ZIP or JSON bytes without network calls, writes or acquisition.
It detects structures rather than relying on filenames, accepts known field
variants and reports unknown or unreadable members individually. Account data
contains playlists; extended streaming history contains listening events and is
reported separately so a wrong export tier has a useful diagnostic. Synthetic
layout evidence is in `backend/tests/fixtures/spotify_export/README.md`.

Resolution registers progress before returning an id, then proposes recordings
without downloading. Import acquires only the explicit reviewed body. Browse
acquisition reuses the catalog ownership oracle in a batch; an unresolvable hit
or an unavailable oracle falls back to acquisition rather than suppressing a
requested track. New audio is staged with metadata and artwork before a single
rename publishes it. A playlist's unknown size starts at total zero and expands
when its track list resolves, retaining the same progress id.

`app.core.*` is a deprecated compatibility alias for one release, retained for
private plugins. It forwards all exports (including private names) and module
state to the corresponding `app.infra.*` module. Backend code must use infra;
CI rejects imports through the compatibility namespace. ML runtimes belong in
the worker package, and are forbidden under `app`.
