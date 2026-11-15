# Logs and troubleshooting

Where each part of Flipspin writes what it knows, and which one to open for a
given symptom.

| Surface | Lives in | Read it with | Survives a restart? |
|---|---|---|---|
| Server log | `~/Krobi/logs/krobi.log` | **Settings → Log**, or `tail -f` | yes (10 MB × 5) |
| Server error log | `~/Krobi/logs/krobi_errors.log` | **Settings → Log** (default tab), or `tail -f` | yes (10 MB × 5) |
| systemd / Docker | the journal / `docker logs` | `journalctl -u krobi-backend` | per your setup |
| Desktop shell and renderer | platform app log directory, `KROBI.log` | **Settings → Log → This computer**, **Open folder**, or the dev terminal | yes (5 MB × 7 files, including active) |
| Helper agent | `~/Krobi/logs/helper-agent.log` on this computer | **Settings → Log → Helper** when present, **Open folder**, or `tail -f` | yes |

## Level policy

| Level | Use it for |
|---|---|
| **error** | Something failed that the person cares about. |
| **warn** | Something unexpected but recovered, or something that will start failing. |
| **info** | Actions the person took and lifecycle events, once; never per poll, heartbeat, status tick or progress event. |
| **debug** | Request details, state transitions and timings. |
| **trace** | Not used by default. |

Production defaults to **info**. Desktop debug builds and `make backend` default
to **debug**; `KROBI_LOG_LEVEL` can override the server level. Repeated status,
account-backfill skips, catalog reads and render/request timings belong at debug.
Use one completion line for an action rather than a line for every progress update.

For yt-dlp, the engine logs one failed download at **error**, with the track and
a reason capped at 500 characters on one line. Keep `ERROR:` lines, or `WARNING:`
lines when there is no error; omit extraction, progress and destination chatter.
Classify rate limits and authentication walls against the full output before
summarising it. Full subprocess output belongs at **debug** only. User/job
cancellation and stopped tasks log one **info** line (`Download cancelled`),
including when yt-dlp reports `Interrupted by user`; cancellation is never an error.

## Server

`app/infra/logging.py` installs three handlers at startup:

- **console** — human-readable, to stdout; under systemd, the journal.
- **`krobi.log`** — the same human-readable lines, rotated.
- **`krobi_errors.log`** — `ERROR` and above only, **as JSON**, with the
  traceback. Grep this one first: it is small and everything in it is a real
  failure.

Level comes from `KROBI_LOG_LEVEL` (default `INFO`), directory from
`KROBI_LOG_DIR`. Server timestamps follow the process `TZ` (UTC when unset),
with an explicit offset on every entry, such as `2026-11-13 11:34:30-06:00`;
JSON keeps ISO-8601 with its offset, and Settings → Log displays the viewer's local time.

Each request is one line
(`GET /api/playlists → 200 in 12 ms [request_id=…]`). Successful requests,
including polls, media ranges and heartbeats, are `DEBUG`; 4xx and 5xx request
lines are `WARNING`. Expected 404s on GET/HEAD reads of
`/api/lyrics/{album}/{file}`, `/api/stems/{album}/{file}` and
`/api/media/{album}/cover.jpg` are `DEBUG` on both server and shell. These
explicit route templates mean optional content is absent; missing audio,
individual stem audio, other errors and writes still warn. Status codes and
response bodies are unchanged. Domain failures retain their own error logs
and tracebacks. The id matches the echoed `X-Request-ID`.
Caller-supplied ids are echoed; otherwise the server generates one. Control
characters in the logged id are flattened to keep the request on one line.
Query strings are omitted.
Uvicorn's duplicate access stream is suppressed, and HTTPX request details are
demoted to debug.

**Settings → Log** in the desktop app reads both files through
`GET /api/logs`. `file` is a key into a fixed allowlist (`app`, `errors`), never
a path, and the search runs server-side over the last 2000 lines.

```bash
# Everything the server considered an error today (use the server's TZ)
grep "$(TZ=${TZ:-UTC} date +%Y-%m-%d)" ~/Krobi/logs/krobi_errors.log

# Follow one domain
tail -f ~/Krobi/logs/krobi.log | grep app.domains.downloads
```

### Known gaps

- **Background jobs lose their reason for failing.** Anything that returns a
  `progress_id` (downloads, playlist imports, lyrics passes) answers
  `200` as soon as the job *starts*. If the job later fails, the progress entry
  records that it failed; the cause is only in `krobi_errors.log`. Also note that
  a progress entry's `completed` counts items *attempted*; `succeeded` and
  `failed` say how they went.

## Route error boundaries

`unexpected_errors_as_500` logs a traceback and retains a route's
`{"detail": "Internal server error"}` response. It belongs under the router
decorator and passes intentional `HTTPException` responses through. The global
middleware has distinct bodies and status mappings for domain errors. Replacing
both with one catch-all would change client-visible contracts. Apply the
decorator only where existing exception branches raise `HTTPException`; a route
that deliberately lets another exception reach middleware needs that boundary.

## Desktop app

The Rust shell and renderer share `tauri-plugin-log`, stdout and the platform
app log directory. On macOS this is `~/Library/Logs/app.flipspin.desktop/`;
other platforms use Tauri's app log directory. The active file is `KROBI.log`,
rotated at 5 MB with six archives (seven files total).
Shell timestamps use the computer's local timezone and include its UTC offset.

Renderer code uses `renderer/src/lib/log.ts`:
`log.playback.info(message, data?)`. Fixed scopes are `app`, `playback`,
`library`, `lyrics`, `stems`, `analysis`, `downloads`, `acquisition`, `sync`,
`settings`, `auth`, `connection` and `plugins`. Each line begins with `[scope]`
and crosses `log:write`; `formatLogValue` safely formats objects, Errors,
causes, cycles and stacks into one physical line. Without the native bridge,
logs fall back to the developer console. The older logger remains compatible;
remaining console-only legacy diagnostics stay in developer tools.

Use `reportError(scope, { userMessage, error })` in action catches. Translate
`userMessage` at the call site. It logs the full error once and calls `notify`
without logging a second time. The toast shows the user message and at most
100 characters from the first error-message line, never the stack. Common
playback, library, download, acquisition, lyrics and analysis actions use it.

A plugin's optional `onLoad({ log })` receives a logger bound by the host to its
discovered directory id, prefixed `[plugin:<id>]`; message data and declared
plugin metadata cannot select that prefix. These are trusted local plugins,
not a JavaScript security sandbox.

Native HTTP diagnostics share `desktop/http_log.rs`. URLs mask `access_token`,
`token`, `key`, `secret`, `password`, `apiKey`, `api_key` and Subsonic `t`/`s`
(case-insensitive, including encoded parameter names); URL userinfo and fragments
are removed. All header values are masked, including `authorization`, `cookie`,
`set-cookie`, `x-api-key`, `x-krobi-token` and configured custom headers.
Bodies are described only by length. Responses expose the protocol request id
separately for correlation. HTTP and body failures include it when a response
was received; transport errors retain their category, OS error and sanitized
URL rather than formatting reqwest's raw error. Discovery uses the same handshake
boundary, and connection/credential diagnostics use the same redaction helpers.
JSON and media proxies share one outage line (`nest unreachable: <reason>`),
then a recovery summary with elapsed seconds and the failed-request count.
Transport failures and gateway responses (502–504) keep per-request detail at
debug during the outage; a complete non-gateway response ends it.

**Settings → Log** retains the server's **Errors** and **All** sources and adds
**This computer** and **Helper**. Local sources use `log:read`, not the remote
server: up to 2,000 tail lines within a bounded 5 MB read, then a case-insensitive
search over that window. Native, server and helper lines use the same viewer,
copy and refresh controls. `log:sources` reports helper availability. Local queries keep working while
the server is offline.
`log:open-folder` opens the selected local directory. Both native actions accept
only `desktop` or `helper`, never renderer-supplied paths. The helper's fixed
legacy `helper-agent.log` → `lyrics-agent.log` link remains readable; other
symlink log files are rejected. **Open folder** is available only for local sources.

The level policy and unified viewer take ideas from
[Nuclear's logging guide](https://github.com/nukeop/nuclear/blob/master/packages/docs/development/logging.md);
no implementation code was copied.

## Symptom → where to look

| Symptom | Open first | Usual cause |
|---|---|---|
| Library empty, no error | developer tools, Network tab | every request is `401`: device not signed in, token revoked, or `KROBI_API_TOKEN` set on one end only |
| "Server not running" in development | — | `make backend` was not started; the dev shell never starts it |
| Download stuck at 0% while the file lands | server log | more than one uvicorn worker, or a proxy buffering the progress stream |
| An import or download says it failed, with no reason | `krobi_errors.log` | see "Background jobs lose their reason" above |
| Catalog matching finds nothing, ever | `krobi.log`, `app.domains.metadata` | MusicBrainz rejects a generic User-Agent; set `KROBI_MUSICBRAINZ_CONTACT` |
| Acquisition fails with "confirm you're not a bot" | `krobi_errors.log` | the source blocks the server; update yt-dlp, then consider a cookies file |
| Audio editor or downloads do nothing | `GET /api/health` | `ffmpeg_available: false`; set `KROBI_FFMPEG_PATH` |
| First launch after an update cannot reach a LAN server (macOS) | shell log | macOS Local Network permission; allow it in System Settings → Privacy & Security → Local Network |
