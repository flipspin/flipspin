# Stems — song splitting on the server

Flipspin splits a song into **drums, bass, vocals, other** (htdemucs), finds its
**beats and downbeats** (beat_this) and cuts **16 chops per stem**, as a job of
the server: the server keeps a queue and the stored results, and a helper (any
computer that processes for the nest: a Mac with Apple Silicon via MLX, a PC with
Nvidia via CUDA, or any PC on its CPU) does the work — the same agent process
that transcribes lyrics. When no helper is online and the owner turned on
"Si no hay otro computer, que procese el server", the nest runs it on its own CPU. The
stems and the analysis are served over HTTP to any client that holds a token,
including a sampler client.

This page is the contract. The server side lives in
`backend/app/domains/stems/`, the worker in `helper/krobi_helper/kinds/stems/pipeline.py`.

## Identity

A track is the library-relative pair **`album`** (the library *directory*
name, not the display album) + **`file`** (the file name) — exactly what
`/api/media/{album}/{file}` takes. Both are URL-encoded in paths.

Auth is the usual Flipspin token: `Authorization: Bearer …`, or `?access_token=`
for the audio URLs (no preflight). A client signs in with `POST /api/login`
(e.g. `deviceLabel: "Sampler"`) and keeps the device token.

## Client routes

All token-gated. Fixed paths are matched before `/{album}/{file}`.

### `POST /api/stems/request`

Any signed-in account may request a split of a song in its library. Owners
and sentinel principals (local client, shared secret, etc.) keep unrestricted
access. A member requesting a song outside its library receives exactly the
same `404` body as if that track were missing: `{detail: "Track not found: <album>/<file>"}`.

Body `{album, file, model?, priority?}` (`model` is `htdemucs`, the only one
offered; `priority` is `now` by default, or `background`).
Answers `{status, jobId}` (a skipped request answers only `{status: "skipped"}`):

| `status` | meaning |
|---|---|
| `queued` | a job is waiting for a helper (`jobId` set) |
| `running` | a helper is on it (`jobId` set) |
| `ready` | already on disk; no new job (`jobId: null`) |
| `skipped` | background splitting is disabled; nothing queued |
| `failed` | — never returned here: asking again for a failed track **is the retry** (it is requeued) |

Idempotent: a queued or running track returns the same `jobId`. A split made
from a file that has since changed (re-download, retag — see `track.source`)
is **stale**: the request enqueues a new job while the old split keeps being
served until the new one lands.

An existing background job is upgraded by a `now` request with the same
`jobId`, including while running; it is never downgraded. Among eligible
queued songs, helpers claim `now` before `background`, then oldest first.
Helper capability, speed ranking and lyrics priority still apply.

There are at most **2 queued background jobs per account**. A third evicts
that account's oldest queued background job and cancels its ledger row.
Leased jobs are never evicted; accounts never evict each other's rows.
Queue rows persist `priority` and `requestedBy` (account id, null for
sentinels); older rows load with priority `now`.

Errors: `404` when the pair is not a library track (this includes any path
traversal attempt and segments starting with `.`), `422` for an unknown model
or priority.

### `GET /api/stems`

Lists stored splits, filtered to the caller's library (owners and sentinels
are unrestricted):

```json
{"splits": [{"album": "…", "file": "…", "title": "…", "artist": "…",
             "albumTitle": "…", "createdAt": "2026-11-08T00:00:00Z", "stale": false,
             "sizeBytes": 18000000}]}
```

`title`, `artist` and `albumTitle` use the library's memoized tags; missing
tags fall back to the file's stem, `Unknown Artist` and album key respectively.
`createdAt` is the manifest's timestamp (null for older manifests without one).
`stale` means the recorded source signature no longer matches the library file,
or that source file is gone. Older manifests without a signature still match
an existing file. The manifest walk is cached by stems directory mtimes at
root, album and track levels; source signatures and tags refresh independently.

`sizeBytes` is the nonnegative sum of the stored file lengths (`stat().st_size`,
in bytes) of `song.json` and `drums.ogg`, `bass.ogg`, `vocals.ogg`, `other.ogg`
under that split's directory. It excludes the original library song, staging,
extra files and symlinks. Missing files (including a concurrent deletion) count
as zero. Sizes are refreshed with file stats on each listing, without reading
their contents. This is an additive list field; the manifest and other routes
are unchanged. The Stems table shows each row's size and its card totals the
listed splits, across all pages and regardless of the search filter; pending
deletions are excluded until undone.

### `GET /api/stems/{album}/{file}`

* `200` — the manifest (`song.json`, below) when the split is ready.
* `202` — `{status, phase, progress, error, agent: {online, lastSeen, name}}`
  while it is not: `status` ∈ `queued | running | failed`; `phase` from the
  list below; `progress` 0–100 or `null`; `error` a sentence when failed.
  `agent.online` lets a client waiting on `queued` say "no helper is
  connected".
* `404` — never requested (or not a track).

### Phases

In order: `queued` · `claimed` · `decoding` · `beats` · `separating` · `chops`
· `encoding` · `uploading`, then the split is `ready`; a failed row shows
`failed`. Beats run *before* separation on purpose (measured faster). Clients
show an unknown value as-is.

### `GET /api/stems/{album}/{file}/{stem}`

`stem` ∈ `drums | bass | vocals | other`. The audio file, **Opus in Ogg**
(`Content-Type: audio/ogg`), 192 kb/s stereo at 48 kHz, with HTTP Range —
the same streaming as `/api/media`. `404` for an unknown stem or no split.

### `GET /api/stems/jobs`

```json
{
  "jobs": [{"album": "…", "file": "…", "status": "queued|running|failed",
            "phase": "…", "progress": null, "error": null,
            "requestedAt": "2026-10-09T22:37:21Z", "updatedAt": "…"}],
  "agent": {"online": true, "lastSeen": "2026-10-09T22:42:01Z", "name": "…"},
  "waitReason": null,
  "oldestAt": null,
  "mode": "agent"
}
```

Finished splits are not listed — the manifest is their record. `agent.online`
means a helper called in within the last 90 seconds (for stems *or* lyrics:
one shared helper registry), without a sleep/quit goodbye; `agent.name` /
`lastSeen` describe the helper the stems queue would use. Each queued job and
the body carry `waitReason` (`no-helper` · `no-capable-helper` ·
`helpers-offline` · `helpers-busy`, from `app/domains/helpers/helper_ranking.py`), and
`oldestAt` is the oldest live request. `mode` is `agent` (helpers drain the
queue) or `local` (the server itself runs the engine).

### `DELETE /api/stems/{album}/{file}`

Owner token only (`403` otherwise). Removes the stored stems and any queued or
running job for the track (the agent learns on its next heartbeat and stops).
Answers `{success, removed}`.
Idempotent: the second delete returns `removed: false`. The deletion logs the
current principal.

### `DELETE /api/stems`

Owner token only (`403` otherwise). Removes every stored ready split directory,
including stale results, and logs the principal and count. Queued and leased
jobs are left alone, including a running replacement for a removed split;
its result can still land. Answers `{removed: n}`; repeated with nothing newly
published answers `{removed: 0}`.

### Background setting

`KROBI_STEMS_BACKGROUND` is a boolean, default **false**, in the `stems` group
of `GET /api/server/config`. The owner changes it live with
`PUT /api/server/config {changes: {KROBI_STEMS_BACKGROUND: true|false}}`.
It persists in the app's `.env`; a process environment value locks it like the
other settings. Disabling it cancels every queued background job across all
accounts, while leased background jobs and foreground jobs continue. While
off, background requests for an accessible existing track return
`{status: "skipped"}` without creating a job.

## The manifest (`song.json`)

```json
{
  "version": 1,
  "track": {"album": "…", "file": "…", "duration": 190.009, "sampleRate": 44100,
            "source": {"size": 3460001, "mtime": 1759960000}},
  "model": "htdemucs",
  "stems": {"drums": "/api/stems/<album>/<file>/drums", "bass": "…/bass",
            "vocals": "…/vocals", "other": "…/other"},
  "analysis": {"bpm": 130.4, "key": "A major", "beats": [0.48, 0.94, …],
               "downbeats": [0.48, 2.32, …]},
  "chops": {
    "full":   [{"start": 0.479048, "end": 5.580023, "label": "bars 1-4"}, …],
    "drums":  [{"start": …, "end": …, "label": "hit 1"}, …],
    "bass":   [{"start": …, "end": …, "label": "bar 7"}, …],
    "other":  [ … ],
    "vocals": [{"start": …, "end": …, "label": "phrase 1"}, …]
  },
  "createdAt": "2026-10-09T22:38:12Z",
  "worker": {"host": "…", "platform": "darwin-arm64", "seconds": 12.8,
             "timings": {"decode": 0.3, "beats": 2.2, "separate": 7.8, "chop": 0.4, "encode": 2.1}}
}
```

* `stems` are **server-relative, URL-encoded** paths; clients prepend the
  server's base URL (and `?access_token=` for an `<audio>` element).
* `track.album`/`file` are always the job's (the server overwrites whatever
  the worker wrote). `track.source` is the library file's size and mtime
  (integer epoch seconds) at publish time — the staleness check above. A
  manifest without it (older splits) counts as valid.
* Chop times are **seconds into the track**, `end > start`, every point
  snapped to a zero crossing of the stem's mono signal (left and right can
  differ, so a client still fades 2–5 ms). Lists are in time order.
* **Up to 16 chops per stem; fewer when the material cannot support 16**
  (a short track, an instrumental's vocals, a near-silent drum stem). Clients
  must handle `length < 16`, including `0`.
* Labels: `full` → `bars 1-4` (k-bar phrases, the largest k of 8/4/2/1 that
  still yields 16) or `slice N` when no beat grid was found; `bass`/`other` →
  `bar N`, or `beat N` when too few bars carry the stem; `drums` → `hit N`;
  `vocals` → `phrase N`.
* How the chops are chosen: *full* = k-bar phrases spread over the song;
  *drums* = the strongest onsets at least max(1 s, 2 beats) apart, each ≤ 1
  beat, behind a loudness gate; *bass/other* = one bar each on the bars where
  the stem plays, spread evenly (bars shorter than 0.75× the median — odd-meter
  bridges — are dropped); *vocals* = phrases split at silences, start snapped
  back to the previous beat, end forward to the next, long ones cut at
  downbeats. `key` is Krumhansl–Schmuckler on bass + other.

## Worker side (the helpers)

The existing agent (`krobi-helper agent --server … `, started by the desktop
app on each computer that has "Process for the nest" on; one agent per computer,
one lock) claims stems jobs too — after lyrics, which keep priority. It picks
MLX on Apple Silicon, CUDA when PyTorch sees an Nvidia card, otherwise CPU
(see the section below). Each job runs in its own `krobi-helper stems` process (the
models' GPU memory dies with it) and reports JSON-line phases that the agent
forwards as heartbeats.

Agent routes (only an owner account's **helper device** token may call them;
any other signed-in token gets `403 not-a-helper` — see
[mac-worker](features/mac-worker.md) § Helpers registry):

* `POST /api/helpers/claim` with `{kinds: ["align", "transcribe", "stems"],
  capabilities: {os, accel, gpu?, chip?, memoryBytes?, platform?, macos?, keepAwake?},
  workerId?, sessionId?, name?, version?}` → **204** when nothing is eligible,
  otherwise `{job: {id, kind, input}, lease}`. Kinds use the existing registry
  names: `align`, `transcribe`, `stems`. The server chooses lyrics first, then
  one stems job. There is at most one active lease per authenticated device,
  across all kinds. `workerId` is informational; the token determines identity.
  For stems, `input` carries `album`, `file`, `mediaPath`, `model`, `attempt`
  (plus the legacy `id`/`jobId` fields). A lease changes on every claim.
* `POST /api/helpers/jobs/{id}/heartbeat` with
  `{lease, phase?, progress?, agent?}` → `{stop: bool, reason?}`. `agent`
  optionally carries the same identity/hardware facts as claim. `stop: true`
  means kill the work and discard the output. Session replacement still returns
  `reason: "replaced"`; a stale lease returns `reason: "lease-lost"`.
* `POST /api/helpers/jobs/{id}/result` — multipart: `lease`, `song.json`,
  `drums`, `bass`, `vocals`, `other` (Ogg/Opus) →
  `{accepted: true, status: "ready"}`. A failure is multipart `lease`, `ok=false`,
  `error`, `final` (`true` = a verdict; `false` = an accident, requeued).
  `422` for a missing part or unservable manifest; `413` when `song.json`
  exceeds 4 MB or a stem exceeds 128 MB, naming the oversized part. Unknown,
  stale or another device's leases return `{accepted: false, reason: "lease-lost"}`.
  Repeating an accepted result under the same job/lease returns its receipt.
  Lyrics use JSON at this same route: `{lease, ok, lrc?, source?, error?, final?,
  lineConfidence?, lowLines?}`.
* `POST /api/helpers/bye` with `{reason: "quit" | "sleep", sessionId?}` releases
  all of that device's leases immediately, without refunding attempts.

Worker **0.10.0** uses these routes and falls back to the old feature routes on
**404 only**, keeping lyrics-first polling against an older server. Other HTTP
errors retain their existing retry/error behavior. The CLI remains
`krobi-helper agent`; the desktop shell does not need a change.

Compatibility aliases keep their exact legacy bodies/responses:
`/api/lyrics/agent/{claim,heartbeat,result,bye}` and
`/api/stems/agent/{claim,heartbeat,result}`. Lyrics claim still returns
`{lease, jobs, queued}` or 204; lyrics heartbeat/result use `jobId` and `lease`,
with `percent` on heartbeat. Stems claim returns
`{id, jobId, album, file, mediaPath, model, attempt}` or 204; `id` is the lease
used by its heartbeat and multipart result. Keep these aliases until
`MIN_WORKER_VERSION` moves **past 0.10.0**, the release shipping the helper API.

Several helpers work together. Each claim goes to the fastest capable
helper first (`app/domains/helpers/helper_ranking.py`: capability match, then measured
seconds per song minute, a slower helper only after the job sat `60 s`
unclaimed, the nest's own CPU last and only when the owner turned it on). A
new `sessionId` for the **same device** replaces that device's previous
process, which receives `{stop: true, reason: "replaced"}` on its next claim or
heartbeat and exits; a different device never replaces another. Late results
from replaced leases are ignored. The nest exposes the helpers' facts and
current jobs as `GET /api/lyrics/jobs` → `engine.worker`; see
[mac-worker](features/mac-worker.md). `POST /api/helpers/bye {sessionId?,
reason: "quit" | "sleep"}` sets that helper `closed` or `asleep` until it calls
in again.

Lease rules: a leased row with no heartbeat for **10 minutes** is requeued by
the next claim; a row goes through at most **3 leases**, then fails with a
reason; rows persist across a server restart, leases do not; a final failure
stays visible as `failed` until the track is re-requested or deleted.

## Storage on the server

`KROBI_STEMS_DIR` (default `~/Krobi/stems`)
`/<album>/<file>/{song.json, drums.ogg, bass.ogg, vocals.ogg, other.ogg}` —
**outside the music library**, so a library scan never sees it. A publish is
staged complete and swapped in by rename, so a reader sees the old split or
the new one, never half of one.

Size: Opus 192 kb/s × 4 stems is about 5× the MP3 — measured 18 MB for a
190-second song, roughly 5.7 MB per minute of music (≈340 MB per hour).
Budget it before splitting a whole library.

## Chop selection

The helper emits at most sixteen chops per stem. Full-track chops use phrases
of the largest bar count among eight, four, two and one that yields sixteen,
spread across the track. Drums select strong spectral-flux onsets behind a
loudness gate, spaced by at least the greater of one second and two beats, with
chops at most one beat long. Bass and other use active bars spread across the
track, falling back to beats when too few bars qualify. Bars shorter than
three-quarters of the median are excluded. Vocals split at silences, expand to
surrounding beats and split long phrases at downbeats.

Every boundary snaps to a zero crossing. Fewer chops are valid for short or
silent material, but every end must exceed its start. Seconds are rounded to
microseconds so converting back with `round(t * sample_rate)` preserves the
chosen sample. Key estimation uses Krumhansl–Schmuckler on bass and other.

## CORS

A Vite development renderer on another origin (e.g. a dev server on
`http://localhost:5174`) must be listed in the server's `KROBI_CORS_ORIGINS`.
JSON routes need the preflight to allow `Authorization` and `Content-Type`
(Flipspin's CORS middleware allows all headers and methods once the origin is
listed); audio uses `?access_token=` and needs none.

## Timings (reference)

On an M1 Pro, warm: a 190-second song takes about 13 s in the worker (decode
0.3, beats 2.2, separate 7.8, chop 0.4, encode 2.1) and about 20 s from
`request` to the manifest answering `200`. The first run after an install is
45–50 s (Metal shader compile, model downloads). The separator runs with
`batch_size=1` (≈5.6 GB of unified memory; the default peaked at 9.2 GB on a
16 GB machine).

## CPU/CUDA separation evidence

The worker selects MLX on Apple Silicon, CUDA when PyTorch reports it available,
otherwise CPU. `KROBI_ACCEL=cpu` (or hidden `stems --accel cpu`) forces CPU even
on a Mac, including beat tracking. The existing MLX separator still uses
`batch_size=1`. CPU/CUDA use PyTorch Demucs **htdemucs**, `shifts=1`, 25% overlap,
trained-length split segments, one segment per batch and `num_workers=0` to
avoid concurrent segments increasing memory. The same four stem names,
44.1 kHz stereo input, chops, key detection and Opus encoding are retained.
Accelerated beat tracking falls back to CPU if its selected device fails.

### CPU (M1 Pro, forced)

| Audio | Wall seconds | Worker seconds | Peak RSS |
| --- | ---: | ---: | ---: |
| 190.0 s excerpt with an existing lyric sidecar | 135.36 | 134.48 | 2,095,693,824 B (1.95 GiB) |
| Separate 190.4 s complete song, first run | 220.11 | 218.23 | 1,748,893,696 B (1.63 GiB) |
| CUDA | — | — | — |

The excerpt's phase seconds: decode **0.48**, beats **5.59**, separate
**123.25**, chops **1.11**, encode **4.04**. The complete-song first run:
decode 0.60, beats 22.39, separate 188.10, chops 1.64, encode 5.48.
Different songs and cold imports make the two observations incomparable as
hardware speed estimates. Four CPU threads were used, with backend tests in
the background. Peak memory is the measured worker child process's macOS
`getrusage` maximum resident size, not total machine/unified GPU memory.
Python 3.12.13, torch 2.14.1, torchaudio 2.11.0, Demucs 4.1.0.

All four generated files were verified by ffprobe: stereo Opus,
190.0065 seconds for the excerpt. The same excerpt also produced 54 aligned
LRC lines on CPU using the fresh vocals stem. Commands, exact output,
transcription dependency decision and remaining validation limitations are in
[the alignment evidence](lyrics-align.md#cpucuda-engine-evidence).
Use isolated model/cache directories and temporary audio copies for these
measurements. CUDA timings and fresh portable installation sizes remain
unmeasured. The CPU transcription measurements are documented separately in
[the alignment reference](lyrics-align.md#cpu-transcription).
