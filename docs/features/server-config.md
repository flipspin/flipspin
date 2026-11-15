# server-config — the nest's own settings, seen and changed from Settings

This desktop section exposes configuration provenance, protected secrets, and
explicit restart states. Phone clients do not include it.

## What it does

An admin opens Settings → Nest → **Advanced** and sees how the nest is set
up — capacity, network, security, folders, logging — with each value saying
where it comes from: Flipspin's default, the server's own file (`/etc/krobi/backend.env`,
`docker -e`), or a change made here. What is safe to change is changed here;
what the server's file pins is shown read-only with that reason; a change
that only takes effect after a restart says so and offers the restart. Secrets
are never shown, only "configured". A normal account never sees the section.

Today all of this lives only in the env file on the server, and the four
switches that already exist in the UI (cookies, write-tags, lyrics auto-fetch,
Spotify keys) have a silent bug this design fixes: **the process environment
wins over `~/Krobi/.env`** (`main.py::_load_env` skips a key already in
`os.environ`), so a switch flipped in the app is applied live, written to
`.env`, and **silently reverted at the next restart** whenever the server's
env file also sets that key.

## Decisions

| question | answer |
|---|---|
| values pinned in the server's env file | behaviour keys (log level, capacity, advertise…) are removed from `deploy/krobi-backend.env.example` and from the home server's `/etc/krobi/backend.env`, so the app owns them; the server file still wins for any key it sets |
| restart from the app | yes: `POST /api/server/restart` exits with code 75 and the supervisor brings it back; unsupervised nests get the command instead |
| restart default | "Al terminar" (after running downloads finish); "Now" is the other choice |
| capacity controls | presets "Ligero · Normal · Potente" suggested from cores/RAM, plus sliders per setting |
| downloads limit | one nest-wide limit for downloads, plus "Trabajos a la vez" for whole jobs |
| pinned values | a lock on each row ("del servidor"), not a section banner |
| older switches | `/config/ytdlp-cookies`, `/config/analysis-tags`, `/config/spotify`, `/api/lyrics/config` writes become owner-only |
| dead keys | delete `KROBI_ENABLE_NORMALIZATION` and `KROBI_YOUTUBE_API_KEY`; rename `KROBI_DOWNLOAD_TIMEOUT` to what it does (the Editor's render timeout) with the old name still read |

## Where a value comes from (`source`)

Decided once at boot, before `_load_env()` runs:

| source | meaning | editable here |
|---|---|---|
| `default` | not set anywhere; Flipspin's built-in value | yes, if the key is editable |
| `env` | set in the process environment before Flipspin started (systemd `EnvironmentFile`, `docker -e`, the shell's own env) | **no** — `409 env-locked`; the env file would win at the next boot |
| `app` | set in `~/Krobi/.env`, i.e. saved from this screen (or one of the older switches) | yes |

`app/infra/env_sources.py` (new) snapshots `{k for k in os.environ if k.startswith("KROBI_") or k.startswith("SPOTIFY_")}`
at import time of `main.py`, before `_load_env()`, and reads `.env`'s keys
after it. That snapshot is the whole mechanism; nothing guesses.

## Server

### `GET /api/server/config` — `require_owner`

```json
{
  "machine": { "cores": 4, "memoryBytes": 8341348352, "arch": "x86_64", "container": "lxc" },
  "restart": { "pending": ["KROBI_LYRICS_ENGINE"], "supported": true, "how": "systemd" },
  "activity": { "downloads": 2, "jobs": 1, "devicesSeen5min": 3 },
  "groups": [
    { "id": "capacity", "settings": [
      { "key": "KROBI_MAX_CONCURRENT_DOWNLOADS", "value": 3, "default": 3,
        "source": "default", "editable": true, "needsRestart": false, "secret": false,
        "kind": "int", "min": 1, "max": 16, "suggestedMax": 4, "unit": "downloads" }
    ] }
  ]
}
```

- **One row per setting**: `key`, `value` (`null` for a secret), `default`,
  `source` (`default` | `env` | `app`), `editable` (false for `env`-sourced
  and for read-only keys), `needsRestart` (this key only takes effect at boot),
  `secret` (then `value` is always `null` and `configured: bool` is present),
  `kind` (`int` | `bool` | `choice` | `path` | `text` | `list`), plus `min`/`max`/`suggestedMax`
  for an `int` and `choices` for a `choice`. `pending` holds the saved value
  of a `needsRestart` key whose saved value differs from the running one.
- The ffmpeg row also carries `version` and `binarySource` (`env` | `system` |
  `bundled`). These describe the running binary, independently of the setting's
  `source` (`default` | `env` | `app`), which controls editability. A saved
  `KROBI_FFMPEG_PATH` override has binary source `env` and setting source `app`.
  Resolution is runnable override → installed ffmpeg (PATH, then macOS
  `/opt/homebrew/bin` and `/usr/local/bin`) → imageio's bundled binary. Version
  probes are cached per path; saving a path always validates it afresh before
  writing anything and applies it live to all consumers. The UI shows labels
  and values for path, version and source, with no explanatory body copy.
- **Labels are not on the wire.** The client maps `key` → its own words
  (English source keys in `t()`, with both catalog lines added by hand; no `i18n:extract`); the server sends codes, like `external-url`'s reason codes.
- `groups[].id`: `capacity` · `network` · `security` · `library` · `logging`
  · `lyrics` · `folders`. Unknown ids are drawn by the client as a plain
  group with the key as label — additive-safe.
- `machine.cores` honours the CPU quota (`os.sched_getaffinity`, then cgroup
  `cpu.max`), because an LXC or a `--cpus 2` container reports the host's
  cores to `os.cpu_count()`. `memoryBytes` honours cgroup `memory.max` for
  the same reason, else `SC_PHYS_PAGES × SC_PAGE_SIZE` (no `psutil`).
- `activity` is what a restart would interrupt: live downloads and jobs from
  the `ProgressTracker`, and devices whose `lastSeenAt` is under 5 min.
- Never in the body: a secret's value or length, a token digest, `users.json`'s path.

### `PUT /api/server/config` — `require_owner`

Body `{"changes": {"KROBI_LOG_LEVEL": "DEBUG", "KROBI_MAX_CONCURRENT_DOWNLOADS": 4}}`.
**All or nothing**: every key is validated first; one failure writes nothing.
Writes go to `~/Krobi/.env` through `core/files.py::write_secret_lines`; a live
key is applied to the running `ConfigManager` in the same request. Answer: the
whole `GET` body (so the client redraws from one source of truth).

| status | `detail` | when |
|---|---|---|
| 200 | — | saved; live keys applied; restart keys now in `restart.pending` |
| 409 | `{"code": "env-locked", "key": …}` | the key's `source` is `env` |
| 409 | `{"code": "read-only", "key": …}` | the key is shown but not editable here |
| 422 | `{"code": "unknown-key", "key": …}` | not in the table |
| 422 | `{"code": "out-of-range", "key": …, "min": …, "max": …}` | int outside `min…max` |
| 422 | `{"code": "not-a-choice", "key": …, "choices": […]}` | choice not offered |
| 422 | `{"code": "bad-type", "key": …}` | wrong JSON type |
| 422 | `{"code": "invalid-ffmpeg", "key": "KROBI_FFMPEG_PATH"}` | missing file, cannot execute, timeout or invalid `-version` output |
| 500 | `{"code": "write-failed"}` | `.env` could not be written; nothing applied |

Above `suggestedMax` is **allowed** (a warning in the client, never a 422):
the person may know the machine better than the probe.

The four older routes (`PUT /api/config/ytdlp-cookies`, `/config/analysis-tags`,
`/config/spotify`, `PUT /api/lyrics/config`) get the same `env-locked` 409
check, and today they are token-gated only — **a member can flip them**. They
become `require_owner`, like every other nest setting.

### `POST /api/server/restart` — `require_owner`

Body `{"when": "now" | "idle"}`. `idle` waits until `activity.downloads` and
`activity.jobs` are both 0 (checked every 5 s, gives up after 30 min and says
so in the log); `now` exits at once. Answer `202 {"restarting": true, "when": …}`.

The process exits with code **75**; it does not restart itself. What brings it back:

| how the nest runs | `restart.how` | comes back because | `supported` |
|---|---|---|---|
| systemd unit (`deploy/krobi-backend.service`) | `systemd` (`INVOCATION_ID` set) | `Restart=on-failure` | yes |
| container from our `docker run` / compose | `docker` (`/.dockerenv`) | `--restart unless-stopped` | yes — a hand-written `docker run` without it does not come back; the client says "si no vuelve, arráncalo en el servidor" after 60 s |
| the desktop's own child (`KROBI_SUPERVISOR=desktop`, set by the shell) | `desktop` | the shell's `watch_backend` respawns a child that exited 75 | yes, after a small shell change |
| anything else (dev `uvicorn`, a bare `python -m app`) | `none` | — | **no**: the client shows the command to run instead |

While a `when: "idle"` restart waits, `GET /api/status` carries an additive
`restarting: true`, so every client (not only the one that asked) draws
"Restarting the nest…" instead of "offline", and a request that arrives
in the last second before the exit gets `503` + `Retry-After: 5` rather than a
reset connection, so a restart appears as a temporary "still starting"
state rather than an error.

A restart drops every client for the ~5–10 s it takes. **What it does to
connected devices**: a song already playing keeps playing from what is buffered
and resumes by Range when the nest answers; phones' downloaded songs are not
touched; the app shows "Looking for your nest…" and reconnects by itself (the
`server:status-changed` path). **What it loses**: the `ProgressTracker` is
memory, so downloads and imports in flight are cut (their files may be half
written into `.part`) — which is why `idle` is offered first. The lyrics and
stems queues persist (`lyrics-queue.json`, `stems-queue.json`); their leases
are re-issued.

### How "needs restart" clears

At boot the server records each restart key's effective value. `restart.pending`
= restart keys whose `.env` value differs from that. After the restart the
recorded value *is* the `.env` value, so the list empties by itself — nothing
to acknowledge. Saving a key back to its running value also clears it.
`GET /api/status` gains only `restarting` (above); the pending list is admin state and stays off the public route.

## Capacity — how much work the nest does at once

The nest runs on anything from a Raspberry Pi to a real server. Three numbers
decide how hard it works; the rest is fixed for a reason the screen gives.

| control | key | today | becomes | range · default | applies |
|---|---|---|---|---|---|
| Descargas a la vez | `KROBI_MAX_CONCURRENT_DOWNLOADS` | `asyncio.Semaphore` **per call** in `downloads/core.py:351` — two acquisitions run 3 + 3 | **one nest-wide limiter** (resizable: a counter + condition, not a fixed `Semaphore`) shared by every job | 1–16 · 3 | live — the next track to start obeys it; running ones finish |
| Trabajos a la vez | `KROBI_MAX_CONCURRENT_JOBS` (new) | unlimited | whole acquisitions/imports running at once; the rest wait as "queued" in the downloads menu | 1–8 · 2 | live |
| Analysis a la vez | `KROBI_ANALYSIS_WORKERS` (new) | `ThreadPoolExecutor(max_workers=2)` hardcoded in `music/repositories.py:159` | the pool's size; a change swaps the executor for new songs, the old pool drains | 1–cores · 2 | live |

`suggestedMax` per control, from `machine`: downloads `max(2, cores)`, jobs
`max(1, cores // 2)`, analysis `max(1, cores - 1)` and ≤ `memoryBytes / 700 MB`
(librosa peaks ~500–700 MB per worker on a long file — measure before shipping).

**Presets** fill the three at once and are only a starting point: "Light"
(1 · 1 · 1), "Standard" (3 · 2 · 2), "Powerful" (6 · 3 · cores−1). The server's
`machine` picks the suggested one: ≤ 2 cores or < 2 GB → Ligero; ≥ 8 cores
and ≥ 8 GB → Potente; else Normal. Moving any slider shows "A medida". The
preset is not stored — only the three keys are.

Shown in the group, not adjustable, each with its reason in a tooltip:

- **Lyrics**: one at a time — the catalogs set the pace (LRCLIB ~1 per second),
  not the machine.
- **Separar y transcribir**: run on the Mac (Motor de letras), not on the nest
  — a link to Lyrics.
- **Ritmo de Deezer / MusicBrainz**: not shown. They are the providers' rules
  (Deezer's quota answers HTTP 200 + error code 4; MusicBrainz ~1 req/s), and a
  faster setting would only get the nest throttled. Not capacity.

## Every setting, classified

**E-live** shown + editable, applied at once · **E-restart** shown + editable,
needs a restart · **RO** shown read-only (env-locked or dangerous) · **—** not
shown. Any E-row becomes RO automatically when its `source` is `env`.

| key | class | group · label | why |
|---|---|---|---|
| `KROBI_MAX_CONCURRENT_DOWNLOADS` | E-live | capacity · Descargas a la vez | becomes nest-wide (above) |
| `KROBI_MAX_CONCURRENT_JOBS` *(new)* | E-live | capacity · Trabajos a la vez | new |
| `KROBI_ANALYSIS_WORKERS` *(new)* | E-live | capacity · Analysis a la vez | new; replaces the hardcoded 2 |
| `KROBI_LOG_LEVEL` | E-live | logging · Detalle del registro | `logging.getLogger().setLevel` at runtime; choices DEBUG·INFO·WARNING·ERROR |
| `KROBI_ENABLE_WAVEFORM_CACHE` | E-live | library · Guardar formas de onda | read at call time |
| `KROBI_ADVERTISE` | E-live | network · Anunciar en la red | `NestAdvertiser` can stop/start; already refreshed on rename |
| `KROBI_LYRICS_ENGINE` | E-restart | lyrics · Dónde corre el motor | auto·local·agent; read once into `LyricsService` |
| `KROBI_NEST_PROCESSES` | E-live | lyrics · Si no hay otro computer, que procese el server | bool, false; owner-only, env-locked, persisted; CPU fallback after 600 s without an eligible real helper |
| `KROBI_MUSIC_DIR` | RO | folders · Music | moving the library from a form is how data gets lost; on a local nest "Library → Elegir carpeta" already exists |
| `KROBI_PLAYLIST_DIR` | RO | folders · Listas | same; also anchors users/instance files |
| `KROBI_STEMS_DIR` | RO | folders · Separaciones | same |
| `KROBI_LOG_DIR` | RO | folders · Logs | same |
| `KROBI_BACKEND_PORT` | RO | network · Puerto | every client and QR code assumes it; fixed at 8000 by the shell |
| `KROBI_BACKEND_HOST` | RO | network · Escucha en | `0.0.0.0` vs loopback decides who can reach it |
| `KROBI_CORS_ORIGINS` | RO | network · Orígenes del navegador | a wrong list breaks the desktop's uploads and the stream; `*` disables credentials |
| `KROBI_REQUIRE_SETUP_TOKEN` | RO | security · Código para reclamar | only matters before the first account; this screen exists only after it |
| `KROBI_API_TOKEN` | RO, secret | security · Clave compartida | `configured` only; rotating it from here would lock out whatever uses it |
| `KROBI_ALLOW_UNAUTHENTICATED_REMOTE` | RO | security · Entrar sin cuenta desde la red | dangerous; drawn as a warning row when true |
| `KROBI_ALLOW_REMOTE_LOCAL_ACTIONS` | RO | security · Acciones locales desde otro computer | dangerous |
| `KROBI_FFMPEG_PATH` | E-live | library · ffmpeg | validated executable override; shows the resolved path, version and binary source |
| `KROBI_YTDLP_PLAYER_CLIENT` | RO | library · Cliente de YouTube | escape hatch, "automatic" when unset; a pinned client can become obsolete as YouTube changes |
| `KROBI_DEMO_OVERRIDES` | RO, only when set | library · Settings de demo | it rewrites downloaded audio; must never be a mystery |
| `KROBI_LYRICS_AUTO_FETCH` | link → Lyrics | — | already "Al añadir canciones" there |
| `KROBI_WRITE_ANALYSIS_TAGS` | link → Analysis | — | already "Write to files" there |
| `KROBI_YTDLP_COOKIES_FROM_BROWSER` / `_FILE` | link → Sources · YouTube | — | already there |
| `KROBI_GENIUS_API_KEY`, `SPOTIFY_CLIENT_ID/SECRET` | link → Sources | — | already there, as secrets |
| `KROBI_ENABLE_NORMALIZATION` | — | — | read into config and used nowhere; remove |
| `KROBI_YOUTUBE_API_KEY` | — | — | read into config and used nowhere; remove |
| `KROBI_DEEZER_ISRC_LOOKUPS` | — | — | trades speed for identity quality; `0` turns off every Deezer STRONG match. Expert knob, env only |
| `KROBI_MUSICBRAINZ_CONTACT` | — | — | a User-Agent contact; the default is right |
| `KROBI_TEMP_DIR`, `KROBI_CREDENTIALS_DIR`, `KROBI_TOOLS_DIR`, `KROBI_MODELS_DIR` | — | — | internal places; `.env` round-trip depends on credentials' parent |
| `KROBI_USERS_FILE`, `KROBI_USER_TRACKS_FILE`, `KROBI_INSTANCE_FILE`, `KROBI_SETUP_TOKEN_FILE`, `KROBI_LYRICS_FILE`, `KROBI_PROVIDERS_FILE`, `KROBI_BROWSE_CACHE_FILE`, `KROBI_DASHBOARD_CACHE_FILE` | — | — | state files; a path to `users.json` is reconnaissance and changing one orphans the household |
| `KROBI_HELPER_SRC`, `KROBI_LYRICS_WORKER_SRC`, `KROBI_LYRICS_PLUGIN_SOURCES`, `KROBI_PLUGINS_DIR`, `KROBI_DEFAULT_SONGS_PATH` | — | — | packaging / development overrides |
| `KROBI_BACKEND_URL`, `VITE_API_BASE_URL` | — | — | client-side, not the nest's (Status → "Change nest") |

## States and controls

| when | the section shows | doing something |
|---|---|---|
| loading | skeletons shaped like the groups; machine facts "…" | — |
| older nest (stock 404 on the route) | muted note: "Este server es de una versión sin esta sección." | — |
| error | "No se pudo leer la configuración del server." + "Retry" | retries |
| value from the server's file | value, lock glyph, word "del servidor"; tooltip names the file (`/etc/krobi/backend.env` or "container variable") | control disabled |
| secret | "configured" / "not set", never the value | — |
| changed, live | value updates; toast "Saved" + "undo" | undo writes the old value back |
| changed, needs restart | row keeps the running value and adds "→ nuevo · al reiniciar"; a bar at the section top: "1 cambio espera a reiniciar el server" + "Restart…" | opens the restart dialog |
| above `suggestedMax` | warn dot + "más de lo que sugiere esta máquina"; allowed | — |
| save failed | in place on the row: why + the value kept | — |
| restart dialog | what stops (n descargas en curso, n dispositivos conectados), "Restart when finished" (default) / "Restart now" | 202 → "Reiniciando…" → back "Online" |
| restart not supported (`how: none`) | the dialog shows the command for this install, copyable | — |
| normal account | the section does not exist (menu, deep link, Overview) | — |

Overview's "To do" gets a row "Reinicia el server para aplicar 1 cambio" while
`restart.pending` is non-empty; the menu item carries the same count as a badge.

## Copy (exact strings)

| where | text |
|---|---|
| menu · title | "Advanced" |
| groups | "Capacity" · "Network" · "Security" · "Library" · "Lyrics" · "Log" · "Folders" |
| machine facts | "4 núcleos · 7,8 GB · x86_64" |
| presets | "Light" · "Standard" · "Powerful" · "A medida"; the suggested one carries "sugerido" |
| source words | "default" · "del servidor" · "changed here" |
| restart bar | "1 cambio espera a reiniciar el server" / "{{n}} cambios esperan…" · "Restart…" |
| restart dialog | "Restart the nest?" · "Restart when finished" · "Restart now" · "Cancel" |
| restarting | "Restarting the nest…" → toast "El server volvió · cambios aplicados" |
| errors | env-locked: "Lo fija el archivo del servidor." · out-of-range: "Between {{min}} and {{max}}." · write-failed: "Could not save to the nest. The value did not change." |

## Decided per app on purpose

Desktop only. The phones keep no nest administration.

## Pinned by

`contracts/server-config.json` (to write with the code): source resolution
(env beats `.env` beats default), every 409/422 code, suggested preset per
machine, `suggestedMax` per machine. `contracts/wire/server-config.json`:
recorded `GET` body. `tests/integration/test_response_contracts.py`: no secret
value ever in the body.

## Not in scope

Editing folders, port, CORS or auth from the UI. A web terminal. Per-provider
rate settings. The phones.
