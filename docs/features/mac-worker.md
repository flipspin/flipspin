# mac-worker — a Mac with Apple Silicon works for the nest, set up with one switch

## Helpers registry

The server now accepts several helpers together. The original single-Mac
runtime below describes the desktop UI; its replacement and enrollment rules
are superseded by these server rules:

- Only an **owner account's helper device token** may call `/api/helpers/*` and the seven legacy lyrics and
  stems agent aliases. Other signed-in credentials receive `403 not-a-helper`;
  revoked tokens receive 401, including on loopback.
- `POST /api/me/devices` accepts optional `helper: true`. Only owners may enroll.
  Existing devices whose label ends in ` · trabajador` remain helpers when the
  stored flag is absent. The flag is persisted privately in `users.json`, while
  device-list bodies keep their existing shape. A member's legacy worker device
  cannot process household jobs.
- `helpers.json` replaces `mac-worker.json` beside the queue files. The old record
  migrates once without changing the source. Each device retains its row; only
  a new session on the same device retires that device's previous session.
- Goodbye (`sleep`/`quit`), session replacement and device/account revocation
  release that helper's leases in **both queues** immediately, keeping attempts.
  Revoked rows remain for 30 days, with state precedence `outdated > revoked >
  goodbye > offline > working/idle`. Goodbye accepts optional `sessionId`; the
  agent now sends it to prevent an old process from closing a newer session.
  Older reason-only byes still address the authenticated device.
- Identity gains optional `os`, `accel`, `gpu`, `jobs`, `keepAwake` (plus the
  existing `chip` and `memoryBytes`). Missing capabilities mean macOS/MLX/all
  three jobs. Reported speed is ignored. `MIN_WORKER_VERSION` stays at 0.7.0
  while these fields are optional, keeping the current Mac agent compatible.
- Lyrics jobs add `engine.helpers` and `engine.waitReason` (`no-helper`,
  `helpers-offline`, or null). `engine.worker` and stems' `agent` select the most
  capable online helper, otherwise the most recently seen. Until speed ranking adds
  measured job ranking, capability orders job coverage, GPU acceleration over
  CPU, then RAM; recency and device id break ties. Queue row changes, scheduling
  and speed measurement remain outside this change.

## One helper API

Worker 0.10.0 claims one job from `/api/helpers/claim`, then heartbeats and
returns its result through `/api/helpers/jobs/{id}/{heartbeat,result}`.
The server chooses lyrics before stems. Helpers are clients with their own
credentials; registry, presence and ranking live in `app/domains/helpers/`.
The agent falls back on 404 to legacy routes for an older server. Keep the old
`/api/lyrics/agent/*` and `/api/stems/agent/*` aliases with identical wire shapes
until `MIN_WORKER_VERSION` moves past 0.10.0 (it remains 0.8.0 today).
The full [agent protocol](../../helper/README.md#agent-protocol-0100)
and [stems wire contract](../stems.md#worker-side-the-helpers) describe both forms.

## Repair missing models

Settings → Add-ons shows "Repair" on both Lyrics and Stems when this
computer's helper reports `models-missing`. Both cards share one engine and
one progress stream. `lyrics:engine-repair` runs only the installed helper's
`prefetch --json`, reusing cached models without rebuilding the environment or
reinstalling packages. A repeated call returns the running operation instead
of starting another. Completion refreshes the local helper status; worker
preferences and credentials are preserved.

## What it does

Lyrics transcription/alignment and song splitting need Apple Silicon; a Linux nest
gets them from a Mac running Flipspin. Setup is three steps: download Flipspin for Mac,
sign in to the nest, turn on **"Usar esta Mac para el server"** (Settings → Este
computer). It installs the engine (~4 GB) and, from then on, works whenever Flipspin is
open on that Mac. Every state the nest can be in about its Mac has a word.

## Runtime (decided)

- **With the app, not a service.** The agent starts when Flipspin starts (switch on,
  engine installed, nest remote) and stops when Flipspin quits — as today
  (`src-tauri/src/lyrics/`). On a normal quit it first sends **goodbye**
  (`POST /api/helpers/bye {reason: "quit"}`) so the nest reads "Flipspin
  cerrado", not "Offline". Before the Mac sleeps (macOS sleep notification in
  the shell) it sends `{reason: "sleep"}` → "Asleep".
- **Own credential.** Turning the switch on mints a device for the signed-in
  account (`POST /api/me/devices`, label "<Mac name> · trabajador"); the agent uses
  that token, never the desktop's. Revoking the device stops the worker alone. The
  token lives with the desktop's credentials in Rust, keyed by nest origin.
- **Stable identity.** The worker's id is the device id, its name the Mac's
  ComputerName (`scutil --get ComputerName`), never the DHCP hostname.
- **One Mac per nest.** A claim from a different worker id makes it the nest's Mac;
  the previous one gets `{stop: true, reason: "replaced"}` on its next heartbeat or
  claim and shows "Otra Mac trabaja para el server" on its own switch.
- **Awake only while working.** The agent holds `caffeinate -i -w <job pid>` for
  the duration of a job, nothing more.
- **uv inside the app.** The build bundles a pinned `uv` binary in the app
  resources; the installer never needs one on PATH and never uses Homebrew's
  Python (`--python-preference only-managed`).
- **Updates come with the app.** On launch, when the bundled worker wheel's version
  is newer than the venv's, the app reinstalls the package (not the models) before
  starting the agent. Bump the worker version on every worker change (the build
  fails if the wheel's code changed and its version did not).
- **Hardware and last error on every heartbeat**: `{id, name, chip, memoryBytes,
  macos, version, state, lastError}` where `lastError` is a code
  (`network-denied` · `token-rejected` · `nest-unreachable` · null).

## The nest's view

`GET /api/lyrics/jobs` → `engine.worker` (additive):
`{id, name, chip, memoryBytes, macos, version, state, lastError, lastSeenAt, job: {title, phase} | null} | null`.
`lastSeenAt` is Unix seconds. The record and goodbye survive a nest restart;
live jobs do not. `outdated` takes precedence when the version is below
`MIN_WORKER_VERSION` (currently `0.7.0`); otherwise a goodbye wins, then the
90-second offline threshold, then working/idle (a live core lease or fresh
working presence while the same agent runs a plugin job). Old `engine.queue` fields remain.
`jobs.oldestPendingAt` and `engine.queue.oldestQueuedAt` (Unix seconds or null)
let clients show the oldest wait without relying on a truncated pending preview.
`engine.waiting {count, oldestAt}` is the union of catalog misses and live queued
tracks, deduplicated by track path; oldestAt is Unix seconds or null. A song
present in both lists counts once, and a queued alignment also counts.

Goodbye accepts `{reason}` for the current Mac; workers also send their `id`
to prevent a late goodbye from closing a replacement.

An optional `sessionId` travels with identity on claim and heartbeat: a replaced
process cannot take over again by polling, but a fresh app launch can reselect
the same stable device id. An agent without an id uses its name for compatibility.

| state | when | word |
|---|---|---|
| `working` | a lease is live | Trabajando |
| `idle` | claimed in the last 90 s, nothing to do | Libre |
| `asleep` | last goodbye was `sleep` | Dormido |
| `closed` | last goodbye was `quit` | Flipspin cerrado |
| `offline` | no claim for 90 s, no goodbye | Offline |
| `outdated` | version below the nest's minimum | Desactualizado |

`token-rejected` and `network-denied` cannot reach the nest; the **Mac** shows them
(its switch row and menu-bar icon): "Credencial rechazada" · "Sin permiso de red".

Settings → Lyrics shows **"la Mac del server"**: one row — state dot + word · name ·
`chip · RAM · macOS` · version (↑ when outdated) · "hace …" — and, when songs wait
and no Mac is working, "N canciones esperando a una Mac" with the oldest wait.

## The Mac's view

Settings → This computer → "Esta Mac para el server": the switch; `MacBook Pro · M1 Pro ·
16 GB`; three dots "En marcha" · "Connected to the nest" · "Trabajando · <song> ·
<phase>"; rows "Funciona: mientras Flipspin está abierto" · "Mientras trabaja: no se
duerme" · "Motor: <version> · <size>" · "Barra de menús: icono" (switch, on by
default). The menu-bar icon's menu: the state line first, then "Trabajar para el
server" (toggle), "Open Flipspin", "Salir".

## Copy (exact strings)

"Usar esta Mac para el server" · "Esta Mac para el server" · "En marcha" · "Conectado
al server" · "Working" · "Free" · "Asleep" · "Flipspin closed" · "Offline" ·
"Outdated" · "Credencial rechazada" · "Sin permiso de red" · "Otra Mac
trabaja para el server" · "Funciona" · "mientras Flipspin está abierto" · "Mientras
trabaja" · "no se duerme" · "Engine" · "Menu bar" · "icono" · "la Mac del
server" · "{{n}} canciones esperando a una Mac" · "Trabajar para el server" · "Abrir
Flipspin" · "Salir".

## Not in scope

Several Macs at once; a background service / login item; the nest serving the
worker build; Intel Macs; a signed and notarised download (the release job).
