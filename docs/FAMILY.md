# The Flipspin family

One server, the Tauri desktop client, and [OpenSubsonic clients](features/opensubsonic.md)
for mobile today. The native Flipspin iOS and Android apps are **coming soon**,
not released with v0.1.0. The first-party apps live in three repositories; the
phone apps already use the shared API in development and sideloaded builds.
This page maps who owns what, where each app's documentation lives, and where
every shared contract is defined and implemented.

## Who is who

| Repo | What it is | Owns | Docs | Read first |
|---|---|---|---|---|
| **`krobi`** (parent) | FastAPI server (`backend/app/`) + Tauri 2 desktop (`src-tauri/`, React renderer in `renderer/`) | **The API contract** and its wire shapes; the server's behaviour (accounts, libraries, jobs, lyrics, mDNS); the desktop look, **Picnic** (`renderer/src/styles/theme.css`, `data-theme="picnic"`) | [`docs/`](.) | [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md), [API_COMPATIBILITY.md](API_COMPATIBILITY.md) |
| **`krobi-ios`** (child) | Native SwiftUI iPhone client, "Flipspin Móvil" — **not released yet** | The phone UI language (**Marcado** tokens), the client-side rules every mobile client follows | [`../krobi-ios/docs/`](../../krobi-ios/docs/) (01–10) | [`../krobi-ios/docs/01-overview.md`](../../krobi-ios/docs/01-overview.md) |
| **`krobi-android`** (child) | Native Kotlin/Compose client: phone, the Unihertz Atom (240 dp) and tablets — **not released yet** | What is *different* on Android (Media3, foreground services, small screens, the tablet's Picnic port and "Sonando" room) | [`../krobi-android/docs/`](../../krobi-android/docs/) (00–10, same numbering as iOS) | [`../krobi-android/docs/00-index.md`](../../krobi-android/docs/00-index.md) |

None of the clients compiles against the server. A renamed field is a runtime
decode failure on a device that cannot be updated in step — hence
[API_COMPATIBILITY.md](API_COMPATIBILITY.md): additive only, `/api/status` is
the handshake, status codes keep their meaning.

## Shared contracts

| Contract | Defined by (server) | iOS implements | Android implements |
|---|---|---|---|
| **Media path / the query-string rule** — `?access_token=` exists only because media players cannot send headers; strip the query before parsing a `url_path`; album identity is the **directory**, not the display name | [API_COMPATIBILITY.md § Authentication on the wire](API_COMPATIBILITY.md#authentication-on-the-wire) | `MediaPath` — [03-networking § The query-string rule](../../krobi-ios/docs/03-networking.md#-the-query-string-rule) | `networking/MediaPath.kt`, `Endpoint.escape` — [03-networking](../../krobi-android/docs/03-networking.md), tested in `ContratosTest` |
| **Accounts, devices, roles** — `/api/me`, `/api/me/devices`, `/api/users` (owner-only, five keys per row), `/api/users/{id}/devices`, labels; 409 for the shared secret | `backend/app/domains/accounts/`, [API_COMPATIBILITY.md § The rules](API_COMPATIBILITY.md#the-rules) | [07-features § Settings — una cuenta, varios dispositivos](../../krobi-ios/docs/07-features.md#ajustes--una-cuenta-varios-dispositivos), [03-networking § Sí hay cuenta](../../krobi-ios/docs/03-networking.md) | `features/ajustes/CuentaStore` — [07-features § Account, devices, Mi biblioteca](../../krobi-android/docs/07-features.md#account-devices-mi-biblioteca) |
| **Mi biblioteca** — `/api/me/library` (per-user references; `DELETE` never touches a file), ownership answered positionally | `backend/app/domains/user_library/` | [07-features § Browse](../../krobi-ios/docs/07-features.md#explorar--the-catalog-surface) | `features/biblioteca/MiBibliotecaStore`, Browse — [07-features](../../krobi-android/docs/07-features.md#account-devices-mi-biblioteca) |
| **Import jobs (server-side "downloads")** — `GET /api/download-progress/{id}`; branch on `terminal`, never `status` | `backend/app/infra/progress.py`, [observability.md](observability.md) | [03-networking § Progress polling](../../krobi-ios/docs/03-networking.md#progress-polling) | `features/inicio/DownloadsStore` — ⚠ not `storage/DescargaManager`, which is the phone's own transfers ([02-architecture](../../krobi-android/docs/02-architecture.md#where-things-live)) |
| **Lyrics sidecar** — `GET/PUT /api/lyrics/{album}/{file}`, `POST /api/lyrics/search`; 404 = none yet; 409 = hand-edited without `force` | `backend/app/domains/lyrics/`, [CONFIGURATION.md § Lyrics](CONFIGURATION.md#lyrics) | [10-lyrics.md](../../krobi-ios/docs/10-lyrics.md) | [10-lyrics.md](../../krobi-android/docs/10-lyrics.md) |
| **Nest discovery** — `_krobi._tcp` (TXT `instanceId`, `version`, `name`), only after the claim; every answer confirmed with `GET /api/status` (no token) | [deployment.md § Finding the server on the LAN](deployment.md#finding-the-server-on-the-lan), [API_COMPATIBILITY.md](API_COMPATIBILITY.md#the-rules) | [03-networking § "Nest"](../../krobi-ios/docs/03-networking.md) | `networking/BuscadorNidos.kt` — [07-features § The nest](../../krobi-android/docs/07-features.md#the-nest) |
| **Access links** — `krobi://acceso?server=…&access_token=…`, shown as a QR | desktop `renderer/src/pairing/accessLink.ts` | [07-features § Settings](../../krobi-ios/docs/07-features.md#ajustes--una-cuenta-varios-dispositivos) | `models/EnlaceAcceso.kt`, `HojaAccesoEntrante` — [07-features § Access links](../../krobi-android/docs/07-features.md#access-links) |
| **Logs** — `GET /api/logs?file=app|errors` (a key, never a path); 404 on an older server | [observability.md](observability.md) | [03-networking § The on-device log](../../krobi-ios/docs/03-networking.md#the-on-device-log) | `ServerLogStore`, `logsServidor` — [07-features](../../krobi-android/docs/07-features.md#account-devices-mi-biblioteca) |
| **Product rules every client keeps** — "nest" is the UI noun for the server; no "me gusta" / bookmark (two song states: in your library, on this device); "canción(es)", "dispositivo" | `backend/app/infra/instance.py`, [deployment.md](deployment.md) | [01-overview § The two download verbs](../../krobi-ios/docs/01-overview.md#-the-two-download-verbs) | [07-features](../../krobi-android/docs/07-features.md#account-devices-mi-biblioteca) |

## Shared cases (`contracts/`)

A rule every client must apply the same way is written once as **cases** —
an input and the answer — in [`../contracts/`](../contracts/README.md), and each
client's own suite reads that file: iOS `Tools/check.sh`, Android
`ContratosTest`, the renderer's vitest. Prose drifts; a failing case does not.
First file: `resolver.json` (title folding, when "Move here" shows, the
"Swap" confirm line) — written after three agents built the same feature
and disagreed on the folder rule.

## How the rules flow

1. **The server's docs define.** A contract is written down here (this
   `docs/` folder, or the server code's own docstrings) before a client depends on it.
2. **Client docs implement and link back.** Each client chapter that uses a
   contract names the server doc it follows. iOS and Android chapters share
   numbering (`03` is networking in both).
3. **A trap found in one client gets a line in its twin's doc** — even if the
   twin is not affected, the line says why not. Most traps are shared.
4. **Each repo's documentation index links to the reasoning**: one line per
   trap, pointing to the chapter that explains it.
