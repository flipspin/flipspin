# Configuration

The server uses environment variables and an optional `--data-dir` startup flag. They are read
once at startup (`backend/app/config.py`); a few can also be changed at runtime
from the desktop app's settings, which persists them for the next start.

The variable names start with `KROBI_` for historical reasons — they are a
contract with existing deployments, so they keep that name.

## Where values come from

In order of precedence:

1. **The process environment** — exported shell variables, the systemd
   `EnvironmentFile`, or the `environment:` block in `docker-compose.yml`.
2. **`<root>/.env`** — saved app settings, read only for keys not already set.
   Credentials use the encrypted store under `KROBI_CREDENTIALS_DIR`.
3. **Built-in defaults**, listed below.

A `.env` in `backend/` or the working directory is ignored with a startup
warning. `KROBI_CREDENTIALS_DIR` selects credentials only, never the settings file.

Because the first value found wins, set any given variable in exactly one
place.

On startup the server creates the directories it needs (`Music`, `playlists`,
`temp`, `logs`, `credentials`) and refuses to start if one of them cannot be
created or written.

## Data root

The server, its desktop child and helper resolve one root in this order:

1. `--data-dir` on `python -m app` or the packaged backend.
2. `FLIPSPIN_DATA_DIR` in the process environment.
3. `KROBI_DATA_DIR`, an accepted alias. If both environment roots are set and
   differ, startup refuses and names both; an explicit flag overrides both.
4. `~/Krobi` if it contains `users.json`, `instance.json`, `jobs.sqlite`, or a
   `playlists/` directory.
5. The OS default: macOS `~/Library/Application Support/Flipspin`, Windows
   `%LOCALAPPDATA%\Flipspin`, Linux `$XDG_DATA_HOME/flipspin` (or
   `~/.local/share/flipspin`). Windows falls back to `~/AppData/Local/Flipspin`
   if `LOCALAPPDATA` is absent.

Nothing is moved or copied during resolution. Startup logs the root and its
source once. `<root>` below means that resolved root. Each existing per-path
`KROBI_*` override still wins for its own path, without relocating siblings.
Root variables in the saved `.env` are ignored: choose the root before startup.
`make dev` selects the repository's `.dev-data/` independently of these inputs.

## Paths

| Variable | Default | What it is |
|---|---|---|
| `KROBI_MUSIC_DIR` | new installs, including the desktop app's own data folder before it holds a library: the OS music folder + `Flipspin` (`~/Music/Flipspin`, `%USERPROFILE%\Music\Flipspin`); an existing `~/Krobi`, a root that already has `Music`, or any other explicit root: `<root>/Music` | The library: one directory per album |
| `KROBI_PLAYLIST_DIR` | `<root>/playlists` | Playlists, one JSON file each |
| `KROBI_TEMP_DIR` | `<root>/temp` | Working files; swept, so keep nothing here |
| `KROBI_LOG_DIR` | `<root>/logs` | `krobi.log` and `krobi_errors.log` |
| `KROBI_CREDENTIALS_DIR` | `<root>/credentials` | Encrypted stored credentials |
| `KROBI_USERS_FILE` | `<root>/users.json` | Accounts, devices and token digests |
| `KROBI_USER_TRACKS_FILE` | `<root>/user_tracks.json` | Per-account library rows |
| `KROBI_PROVIDERS_FILE` | `<root>/providers.json` | Which providers are enabled, in what order |
| `KROBI_INSTANCE_FILE` | `<root>/instance.json` | The server's `instanceId` and its optional `name` (what the app calls the nest). A relocated data directory needs its own file |
| `KROBI_SETUP_TOKEN_FILE` | `<root>/setup-token` | Where the first-run setup code is written (`0600`) |
| `KROBI_JOBS_FILE` | `<root>/jobs.sqlite` | Durable jobs, item outcomes and helper leases (SQLite WAL). Defaults under the data root |
| `KROBI_STEMS_DIR` | `<root>/stems` | Split-song manifests and four Opus stems, outside the music library; roughly 18 MB per three-minute song. Leases live in the shared jobs database |
| `KROBI_LYRICS_FILE` | `<root>/lyrics.json` | Metadata about the lyric files beside the audio |
| `KROBI_BROWSE_CACHE_FILE` | `<root>/browse-cache.json` | Cache of catalog pages. Must not live under the temp dir |
| `KROBI_DASHBOARD_CACHE_FILE` | `<root>/dashboard-cache.json` | Cache of the home screen's catalog rows. Same rule |
| `KROBI_TOOLS_DIR` | `<root>/tools` | Persistent host programs; keep this directory in the data volume. |
| `KROBI_MODELS_DIR` | `<root>/models` | Models those programs download |

The API music-folder switch accepts paths under the server user's home or the
resolved data root, checking containment after resolving symlinks. Explicit
startup music overrides may point elsewhere.

## Access and network

| Variable | Default | What it does |
|---|---|---|
| `KROBI_REQUIRE_SETUP_TOKEN` | `false` (`true` in the Docker image) | Creating the first account (`POST /api/claim`) must present the setup code. Turn it on before starting an unclaimed server on a shared network |
| `KROBI_API_TOKEN` | unset | Legacy shared secret, accepted as an owner. Set, it is required from every caller, loopback included. Accepted as `Authorization: Bearer`, `X-Krobi-Token`, or `?access_token=` |
| `KROBI_ALLOW_UNAUTHENTICATED_REMOTE` | `false` | Serves remote callers without any credential. An escape hatch; warns at startup |
| `KROBI_ALLOW_REMOTE_LOCAL_ACTIONS` | `false` | Lets remote callers use the routes that act on the server machine itself (open a file, change or reset the library directory, burn a CD) |
| `KROBI_CORS_ORIGINS` | loopback dev origins and the Tauri origins | Comma-separated browser origins; `null` requires explicit opt-in. Keep the Tauri origins (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`) for direct browser requests; the Rust proxy sends no Origin. A value containing `*` allows CORS for every origin and disables credentials, but does not grant tokenless local-owner access to browser pages |
| `KROBI_ADVERTISE` | `true` | Once the server has an owner, announce it on the LAN over mDNS as `_krobi._tcp`, so desktops list it by name. Never before the first account exists. `false`, `0`, `no` or `off` disables it. mDNS does not cross a VPN, and from a Docker bridge network it does not reach the LAN; the typed address works either way |
| `KROBI_BACKEND_HOST` | `0.0.0.0` | Bind address exported by `python -m app` and the packaged binary from `--host`; discovery skips loopback binds. Under plain uvicorn, match its command line |
| `KROBI_BACKEND_PORT` | `8000` | The port the Spotify OAuth callback URL and the LAN advertisement use. `python -m app --port N` (and the packaged binary) sets it from its own flag; under plain `uvicorn`, the listening port is set on its command line and this must match it |

How accounts, devices and the first claim work is described in
[the security policy](../.github/SECURITY.md).

Members' music listings, summary counts, media, covers, waveform and decomposition
routes are limited to their per-account library rows. Deleting a track as a member
removes only that reference; moving files and editing shared tags require an owner.
Catalog ownership markers use the member's tracks, and catalog acquisition reports
existing files as successful downloads while linking them without transferring audio.
The library-derived dashboard recommendations are omitted for members. Owners and
synthetic principals retain the shared catalog view. This scope currently covers
music and catalog acquisition; other feature domains keep their existing access rules.

## Providers and API keys

| Variable | Default | What it does |
|---|---|---|
| `KROBI_GENIUS_API_KEY` | unset | Genius API token; does not enable lyrics scraping by itself |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | unset | Spotify Web API credentials. Saved from the app into the encrypted credentials store |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:<KROBI_BACKEND_PORT>/api/spotify/callback` | OAuth callback. Must match the Spotify dashboard exactly |
| `KROBI_MUSICBRAINZ_CONTACT` | the project URL | Contact put in the User-Agent MusicBrainz requires. A generic User-Agent gets a 403 that looks like "no results" |
| `KROBI_DEEZER_ISRC_LOOKUPS` | `3` | Extra Deezer lookups per search to obtain an ISRC. `0` disables them, and with them automatic acceptance of Deezer-only matches |

Which providers are used, and in what order, is set in the app under
**Settings → Sources** and stored in `KROBI_PROVIDERS_FILE`.

**LRCLIB is the default lyrics source** (synchronized lyrics, no key). Genius
lyrics are off by default, including when upgrading an older provider preference
file. To opt in, configure a Genius access token in **Settings → Sources → Lyrics → Genius**
(or `KROBI_GENIUS_API_KEY`), then turn on its switch there. **This scrapes
genius.com song pages; the Genius API does not return lyrics.** Both the key
and the enabled switch are required. Disabling the switch or removing the key
stops subsequent Genius lyrics requests without a restart. Explicit consent is
stored as `lyrics.opted_in: ["genius"]` in `providers.json`; an old implicit
`enabled` state is not consent. Other Genius metadata operations requested by
URL remain separate from this lyrics switch.

Spotify sign-in does not work against a remote server over plain HTTP: the
consent page runs on the client and Spotify rejects non-TLS redirects to a LAN
address. Playlist import uses Spotify's data-export archive instead, which needs
no credentials.

## Acquisition and audio

| Variable | Default | What it does |
|---|---|---|
| `KROBI_FFMPEG_PATH` | unset | Explicit ffmpeg binary. Unset: the static binary bundled with the Python dependencies, then `ffmpeg` on `PATH` |
| `KROBI_MAX_CONCURRENT_JOBS` | `2` | Whole acquisitions/imports at once, 1–8; live |
| `KROBI_ANALYSIS_WORKERS` | `2` | Deprecated compatibility setting for the existing settings presets; no effect on helper analysis |
| `KROBI_ANALYSIS_AUTO` | `true` | Automatically analyse arrivals from downloads/uploads, files copied into the music root after its baseline scan, and previously analysed files whose content changes in place. Live owner setting; process environment values lock it. Turning it off cancels queued automatic arrivals; leased work and owner runs continue. See [analysis.md](analysis.md) |
| `KROBI_MAX_CONCURRENT_DOWNLOADS` | `2` | Concurrent fetches per streaming source, clamped to 1–4; live. Processing (ffmpeg/tags) and import each run one at a time. Metadata lookups retain provider pacing (MusicBrainz: 1/s). |
| `KROBI_EDITOR_RENDER_TIMEOUT` | `300` | Editor's render timeout, seconds (falls back to `KROBI_DOWNLOAD_TIMEOUT`) |
| `KROBI_YTDLP_COOKIES_FROM_BROWSER` | unset | Browser the installed audio source reads cookies from (`chrome`, `safari`, `firefox`, …). The server passes it to the source plugin. Settable in the app; useless on a headless server |
| `KROBI_YTDLP_COOKIES_FILE` | unset | Path to a `cookies.txt` the server passes to the source plugin, the headless alternative. It holds live session cookies — treat it as a password |
| `KROBI_WRITE_ANALYSIS_TAGS` | `false` | Opt-in MP3/FLAC/OGG tag writes after the store commits: confident computed values carry a `KROBI_ANALYSIS` marker; owner corrections overwrite tags without it. Estimates stay in the store and foreign tags are preserved. See [analysis.md](analysis.md) |
| `KROBI_ENABLE_WAVEFORM_CACHE` | `true` | Cache computed waveforms |

You are responsible for what you acquire and for respecting the copyright and
terms of service of the sources you configure.

## Lyrics

| Variable | Default | What it does |
|---|---|---|
| `KROBI_LYRICS_AUTO_FETCH` | `false` | Fetch lyrics for every song without them: a pass at startup and one after every acquisition. Settable in **Settings → Features → Engines → Lyrics sync** |
| `KROBI_LYRICS_ENGINE` | `auto` | Legacy placement migration input for one compatibility release; configure work in Settings → Features → Helpers |
| `KROBI_HELPER_SRC` | bundled / repo `helper/` | Where the optional helper engine is installed from |
| `KROBI_LYRICS_WORKER_SRC` | unset | One-release fallback alias for `KROBI_HELPER_SRC` |

## Plugins

`KROBI_PLUGINS_DIR` selects a directory of trusted, locally installed backend
plugins. The default is `plugins/` beside the configured playlists directory.
A missing directory loads no plugins. See [PLUGINS.md](PLUGINS.md) for the
backend, renderer and worker extension contracts.

## Logging

| Variable | Default | What it does |
|---|---|---|
| `KROBI_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` or `CRITICAL` |
| `TZ` | `UTC` | Process timezone for server log timestamps, for example `Europe/Paris`; timestamps include the UTC offset. |

See [observability.md](observability.md) for what each log contains.

## Demo recordings

| Variable | Default | What it does |
|---|---|---|
| `KROBI_DEMO_OVERRIDES` | unset (off) | Path to a JSON rule file of per-song exceptions, for recording a demo |

Each rule matches a substring of the normalized `artist title` and can trim the
start of the acquired audio and shift the timestamps of a fetched synced lyric:

```json
[{"match": "money for nothing", "trim_start_s": 81, "lyrics_offset_s": -13}]
```

The file is re-read on every use, so it can be edited between takes without a
restart. Every rule that fires is logged at `WARNING`. Unset, nothing here runs.

## Desktop app

The desktop app reads its own settings rather than these variables. These
environment variables matter to it:

| Variable | What it does |
|---|---|
| `KROBI_BACKEND_URL` | Points the app at a remote server (`http://your-server:8000`) and locks that choice: the first-run "Where's your nest?" screen is skipped and **Change nest** cannot change it |
| `KROBI_API_TOKEN` | Legacy shared secret the app presents when no account is signed in on this device. For the bundled server it is also read from `<root>/.env` |
| `VITE_API_BASE_URL` | Backend URL for browser-only renderer development (`make frontend`) |
| `VITE_API_TOKEN` | Token for browser-only renderer development, where there is no desktop shell to hold one |

The app sets two variables itself when this computer is the nest and it starts
the bundled server; nothing needs to set them by hand:

- `KROBI_DEFAULT_SONGS_PATH` — the folder of starter albums copied into an empty
  library.
- `KROBI_REQUIRE_SETUP_TOKEN=true` — the bundled server listens on the LAN
  (`--host 0.0.0.0`) so other devices can reach it, so its first account needs
  the setup code. The app reads the code from `<root>/setup-token` and hands it
  to its own account-creation screen; nobody on the network can claim it first.

Where the app keeps its own choice of nest is described in
[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md).

## Example `.env`

```bash
KROBI_MUSIC_DIR=/srv/music
KROBI_REQUIRE_SETUP_TOKEN=true
KROBI_GENIUS_API_KEY=your_genius_api_key
KROBI_LOG_LEVEL=INFO
```

## Getting API keys

- **Genius** — create an API client at <https://genius.com/api-clients> and use
  its client access token.
- **Spotify** — create an app at <https://developer.spotify.com/dashboard> and
  register the exact `SPOTIFY_REDIRECT_URI`.

## Owner-managed server settings

`GET /api/server/config` reports machine limits, activity, provenance and editable
settings. `PUT /api/server/config` validates a whole batch before atomically
saving it to the app's private `.env`. A key present in the process environment
at boot is pinned (`source: env`), including an empty value, and cannot be saved
from this API or the older cookies, analysis-tags, Spotify and lyrics switches.
All these writes require the owner role. Defaults and app-saved keys can be
changed from Settings → Nest → Performance, Network and Security; leave behaviour keys out of the server's
environment file unless deliberately pinning them.

[Background work](features/background-work.md) owns placement and computer limits.
The nest starts eligible work according to its per-kind policy. These variables
seed its limits on first migration; process-environment pins remain authoritative.
Subsequent app changes are stored in the jobs database from the nest's computer sheet.

`KROBI_NEST_PROCESSES`, `KROBI_LYRICS_ENGINE` and `KROBI_STEMS_BACKGROUND` are
one-time migration inputs. Their old controls are removed; compatibility keys
remain for one release.

| Variable | Default | Meaning |
|---|---|---|
| `KROBI_NEST_CPU_PERCENT` | `50` | 1–100 percent of one CPU core, across the helper's processes. Uses cgroup v2 `cpu.max` when delegated; otherwise nice + a supervised stop/resume duty cycle. If neither is allowed, the nest cannot claim work. |
| `KROBI_NEST_MAX_TEMP_C` | `85` | Pause at this temperature, using the hottest readable `/sys/class/thermal/thermal_zone*/temp` sensor. |
| `KROBI_NEST_RESUME_TEMP_C` | `75` | Resume at or below this temperature; must be below the stop temperature. Paused work keeps its lease. |

The nest has no schedule. Remote helpers follow their own saved hours.
Changing the nest's CPU limit requeues active work before it runs under the new cap. Missing thermal
sensors do not block work; after a hot reading, work stays paused until a valid
cool reading arrives. The nest reserves half its effective memory for serving;
cgroup mode also enforces that helper memory budget.

Helper claims use `now` (a waiting person), `new`, then `library` lanes, with
round-robin turns across eligible kinds in each lane. Owner-requested library analysis runs have their own Jobs labels.
Engine changes require an owner to press **Analyse now**. New lyrics and
stems helper results include `worker`, `analyzed_by`, `helperName`, `accel` and
`version` alongside timing metadata; the ledger retains the same provenance.
Existing results are not backfilled. The nest's Helpers row includes typed
`blockedReasons` (`no-engine`, `no-cgroup`, `memory`, `thermal`), including
per-kind required and available memory where applicable.

Download concurrency is one nest-wide, live limit (1–16, default 3), shared by
all jobs and single-track downloads. Lowering a limit lets admitted work finish.
Analysis pool changes send new songs to a new pool while the old pool drains.
`POST /api/server/restart` defaults to `when: idle` (up to 30 minutes for running
jobs), or accepts `now`. Supervised nests exit 75: systemd, the Docker restart
policy, or the desktop child watcher brings them back. An unsupervised nest
returns a command without exiting. `/api/status` exposes only the additive
`restarting` flag; pending configuration stays owner-only.

Capacity suggestions use effective cores and memory (affinity and cgroup limits),
with 700 MB of memory budget per analysis worker. A local measurement on macOS
arm64 / Python 3.12 with a synthetic ten-minute WAV peaked at 363.7 MB RSS for a
single analysis process; the analysis reads only its first 60 seconds. This is a
conservative suggestion, not a measured upper bound for every format or host.

## Release checks

| Variable | Default | What it is |
|---|---|---|
| `KROBI_UPDATE_CHECK` | `true` | Check GitHub for a newer nest version. Owner-editable live in Settings → Nest → Network; a process environment value locks it. `false` stops Flipspin version checks, including manual requests. |
| `KROBI_SUPERVISOR` | unset | The desktop sets `desktop` for its child server. Under a supervisor, exit 75 requests a restart; unsupervised restart requests return instructions without exiting |
| `KROBI_INSTALL_METHOD` | `unknown` | Packager declaration: `script`, `compose`, `unraid`, `systemd`, or `desktop`. The Docker image defaults to `compose`; the installer, Unraid template and systemd unit declare their own method. `KROBI_SUPERVISOR=desktop` takes precedence. |
| `KROBI_UPDATE_CHECK_FILE` | `<root>/update-check.json` | Last successful version, ETag, check/error timestamps and error code; no release prose or feed URLs. |

The installer passes `KROBI_TAG` into its container. A tag other than `latest`
marks a pinned install; a pinned script install is never offered `flipspin update`,
because that command only pulls the saved tag. See [Update notice](features/update-notice.md).

## Public-server URL and proxy policy

`FORWARDED_ALLOW_IPS` defaults to `127.0.0.1` in the server image and systemd
unit. Uvicorn reads this environment variable directly. Set it in the service's
environment file or Compose environment to a comma-separated list of actual
reverse-proxy peer addresses if the proxy connects from elsewhere. Never use
`*`: arbitrary forwarded addresses would let callers evade IP failure windows.
Forwarded requests never receive the local-owner exception.

`KROBI_DOWNLOADER_ALLOWED_HOSTS` adds comma-separated exact hostnames to the
union of enabled sources' advertised `urlHosts`. For example,
`media.example.org` permits that host, without permitting its subdomains. Only
add trusted public services: source plugins make their own media requests. URLs must use HTTP or HTTPS and must not contain user credentials.
Legacy acquisition URL fields use the same source-host policy.

Cover and provider-page fetches resolve and reject non-public addresses before
each connection, including up to three redirects. Connections use the checked
address while retaining TLS hostname verification. Responses have a 10 MiB
streamed cap and a ten-second read timeout (five seconds to connect); cover
responses must have an image content type. Encoded responses are refused.
These guarded fetches do not use ambient HTTP proxy settings.

## Source plugins

Sources and their tool updates are installed independently. See
[Source plugins](PLUGINS.md#source-plugins). `KROBI_UV` selects the uv executable
used to build source environments; bundled desktop nests set it automatically.
`KROBI_SOURCE_LOCATION_YOUTUBE` is owner-editable text, empty by default, that
prefills the legacy source's installation sheet. It never installs code itself.
The `KROBI_YTDLP_COOKIES_FROM_BROWSER` and `KROBI_YTDLP_COOKIES_FILE` names
remain compatibility aliases for host-managed source cookies.

## Product rename compatibility

The published server image is `ghcr.io/flipspin/flipspin-server`, and the Compose
service is `flipspin`. All `KROBI_*` environment variables, including `KROBI_IMAGE`,
keep their existing names and precedence. `FLIPSPIN_DATA_DIR` selects the shared data root; `KROBI_DATA_DIR` is its alias.
New script installs provide `flipspin` and the compatible `krobi` command;
existing servers can continue using `krobi` and their saved Compose service.
The handshake still reports `app: "krobi"`; the default public name is Flipspin.
The `_krobi._tcp` service type, `krobi://` setup links, API routes, JSON fields,
plugin contracts, IPC channels and browser-storage keys are unchanged.

Saved image overrides remain authoritative on existing script installs. Set
`KROBI_IMAGE=ghcr.io/flipspin/flipspin-server` in the installer’s saved `.env`
to follow the renamed image when upgrading an older installation.
