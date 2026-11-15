# Analysis helper protocol

Analysis uses the shared helper queue. The server enqueues tracks during a
change-only background scan (one pass at boot, then when folder signatures
change) and on upload or acquisition completion. The loop checks for changes
every 30 seconds. Reading a listing never enqueues work.

An enrolled owner helper calls `POST /api/helpers/claim` with `kinds` including
`analysis` and `capabilities.labels` including `analysis>=2`. There is no analysis
memory minimum. Queue lanes run waiting-person work (`now`), then acquisitions
(`new`), then library passes (`library`), rotating eligible job kinds within each
lane. An empty claim returns **204**;
a successful claim returns **200**:

```json
{
  "job": {
    "id": "item-id",
    "kind": "analysis",
    "input": {
      "items": [{
        "relPath": "Album/song.mp3",
        "album": "Album",
        "file": "song.mp3",
        "size": 123456,
        "mtimeNs": 1700000000000000000,
        "mediaUrl": "/api/media/Album/song.mp3"
      }]
    }
  },
  "lease": "lease-id"
}
```

A claim leases up to **25** songs under one lease. Download each `mediaUrl`
using the helper's token. Keys use `∕` (U+2215) to fold nested directories;
URLs percent-encode each of the two key segments. Preserve `size` and `mtimeNs`
from the claim, rather than deriving them from the downloaded copy.

Heartbeat `POST /api/helpers/jobs/{id}/heartbeat` with
`{"lease":"lease-id","phase":"analizando","progress":0.5}` renews the batch.
Leases expire after ten minutes without a heartbeat, with at most three attempts
per item. `{ "stop": true, "reason": "lease-lost" }` means stop this work.

Post all item outcomes to `POST /api/helpers/jobs/{id}/result` as JSON:

```json
{
  "lease": "lease-id",
  "items": [
    {
      "relPath": "Album/song.mp3",
      "size": 123456,
      "mtimeNs": 1700000000000000000,
      "engine": "keyfinder+tempocnn",
      "engineVersion": 2,
      "key": "5A",
      "keyConf": 0.9,
      "bpm": 123.4,
      "bpmConf": 0.9,
      "energy": 0.06,
      "brightness": 0.25,
      "pulse": 1.6,
      "trackLufs": -22.5,
      "truePeak": 0.8,
      "lra": 3.2,
      "loudnessBlocks": [-22.4, -22.6],
      "decodeSeconds": 1.1
    },
    {
      "relPath": "Album/other.mp3",
      "ok": false,
      "error": "undecodable",
      "final": true
    }
  ]
}
```

Keys are `1A`–`12B`; BPM is 30–300 (both null for tracks shorter than 12 seconds); confidences are 0–1. All numeric
measurements must be finite. Mood is computed by the server. Use `undecodable`,
`too-short` or `engine-failed` as applicable; `final:false` requests another
attempt. A verdict such as an undecodable file is final.

A **200** response contains `accepted:true` and `items`, each with `relPath` and
`status`. An invalid measurement has item status **422** and `error`; valid
siblings still apply. A changed signature returns `dropped:true` for that item
and schedules a fresh signature. A stale or foreign lease returns **200** with
`accepted:false, stop:true, reason:"lease-lost"`. Repeating a completed result
returns the original receipt without applying or writing tags again. Malformed
envelopes return HTTP **422**. Ordinary owner/member credentials cannot claim
work (**403**); invalid credentials return **401**.

Owner corrections use `PUT /api/analysis/{relPath}/fixed` with `rev` and optional
`key`/`bpm`. Null clears that correction; absent fields stay unchanged. **409**
returns the current row on a revision conflict; invalid values return **422**.
Fixed BPM corrections accept 20–300; helper measurements remain 30–300.
The `computed` object also exposes `keyEstimated` and `bpmEstimated`, independent
of corrections and file tags.
Changed computed results advance `rev` as well, so a confirmation of an older
estimate conflicts instead of fixing a stale value. Identical checks leave the
revision, analysis timestamp, listing revision, files and edit journal unchanged.
`GET /api/analysis/{relPath}` returns effective values with source/estimated
flags, `computed`, `fixed`, `rev` and `state`. Missing/out-of-scope paths return
**404**, and members cannot correct (**403**). The owner-only
`GET /api/analysis/summary` returns coverage and helper presence, with an ETag
and **304** support.

With `KROBI_WRITE_ANALYSIS_TAGS` enabled, MP3/FLAC/OGG writes occur after the
store commits. Computed tags carry `KROBI_ANALYSIS=keyfinder+tempocnn@2` (an ID3
TXXX frame for MP3). File keys use compact musical note names; the API retains Camelot values.
Key writes also maintain a private `KROBI_CAMELOT` tag (`TXXX:KROBI_CAMELOT`
in MP3, an iTunes freeform atom in MP4). On startup, a versioned pass converts
legacy app-owned Camelot key tags with at least 0.1 seconds between files.
It checks recorded per-field ownership and values, preserves foreign tags and
outside corrections, and journals each change with its refreshed analysis signature.
Files without matching stored provenance are left untouched, even if a marker remains.
Interrupted passes resume on the next startup; write-back must be enabled.
Estimates never leave the store as tags; foreign tags are
preserved. Corrections retain per-field Flipspin ownership in the store; the marker is
present when an owned computed field is also written. Reset restores a pre-existing foreign value; otherwise
normal confidence rules rewrite a computed tag with the marker or remove an
owned estimate tag. Disabling write-back leaves the file untouched. Other formats retain
corrections in the store.

The nest runner checks module specs using the tools interpreter, then invokes
`krobi-helper analysis --accel cpu --jobs <spec> --out-dir <out>` at nice 10.
The spec is the claimed items plus a local `audio` path. The child emits the
ordinary phase events and a `done` event containing `items`, or writes that
array to `analysis.json` in the output directory. Only one nest batch runs, and
analysis waits while lyrics or stems is leased. The helper implementation is
provided separately.

The analysis add-on installs `krobi-helper[analysis]` (numpy, onnxruntime CPU,
`krobi-keyfinder`); it does not need the lyrics/stems `engine` extra. Installers
preserve the union of selected extras when updating existing environments.
`check` reports analysis readiness separately from `engineReady`.

`prefetch --addon analysis` downloads the pinned `deeptemp-k16-3.onnx`, verifies
SHA-256 `36899ddcebd8587ad83cf73e4011e5ce8a1447eb3c5e5c574289d37168f8aa60`,
and writes an AGPL notice and source graph link beside it. The release asset
at `analysis-models-v1` must be uploaded before release. For offline checks,
`KROBI_TEMPOCNN_URL` accepts a local file or URL; the checksum still applies.
The one-off exporter is `helper/tools/export_tempocnn_onnx.py`; TensorFlow and
tf2onnx belong only in its disposable export environment.

Audio is decoded once by ffmpeg to 44100 Hz mono float32. KeyFinder consumes
that whole signal; ffmpeg resamples the same samples to 11025 Hz for tempo.
Tempo features use centered 1024-sample symmetric Hann magnitude spectra,
512-sample hops, 40 Slaney mel bands (20–5000 Hz, triangular area normalization),
256-frame patches with hop 128, discarding incomplete patches. Each patch is
standardized, and its 256-class softmax is averaged with the other patches.
BPM is the winning index plus 30; tempo confidence is its averaged probability.
The pinned Essentia implementation uses **no log compression** in this path.
Its source revision is cited in `kinds/analysis/tempo.py`; the latest published
Essentia tag predates TempoCNN. Key confidence is the difference between the
largest and second-largest of KeyFinder's 24 cosine profile scores.

The helper returns these mood inputs, all from that same decoded signal:

- Energy: `sqrt(mean(samples²))`, RMS amplitude.
- Brightness: mean of each frame's magnitude-weighted frequency centroid,
  divided by Nyquist; 2048-sample Hann frames, hop 512, silence contributes 0.
- Pulse: standard deviation divided by mean of positive spectral flux
  (`sum(max(magnitude[t] - magnitude[t-1], 0))`), using the same frames;
  silence contributes 0. This is a dimensionless onset-strength variation.

FFT work is chunked to bound temporary memory. Inputs shorter than 12 seconds
are final `too-short` failures; invalid decodes are final `undecodable` failures.
Other engine exceptions are retryable `engine-failed` failures. One failed item
does not end its batch. One child process owns the models for an entire batch,
and lease loss terminates that process group without publishing results.

Owner-only `GET /api/analysis/estimates?after=<relPath>&limit=50` returns
`rows` and an `after` cursor (null at the end). Rows use effective values and
per-field `keySource` / `bpmSource`, ordered by case-folded artist, title and
relPath. Scope is applied before pagination. Summary adds `estimated` counts
with `songs`, `keys` and `bpms`. Listing provenance is additive; existing keys
retain their meanings.

Missing audio files retain their analysis and tag provenance as ghosts. A sweep
records when each file first goes missing and clears that timestamp if the same
relative path returns. Ghosts are excluded from summary counts, estimates and
analysis scheduling; the API shapes are unchanged. After 30 days missing, only
rows with neither a fixed key nor a fixed BPM may be purged automatically.
Corrections and confirmations are retained indefinitely. Sweeps skip an absent,
unreadable or audio-empty library entirely, including purges. Moves within Flipspin
continue to repoint the existing row and its tag provenance.

Listing rows, estimate-review rows and `GET /api/analysis/{relPath}` expose
nullable `keyConfidence` and `bpmConfidence`. These describe only the effective
computed value; file tags, corrections and missing values return null. The
existing value, source and estimated fields retain their meanings.

The renderer ships anonymous aggregate accuracy measurements dated 2026-11-12
in `analysis/accuracy-data/`. `analysis/calibration.ts` is the versioned
calibration source for tooltips and Settings → Add-ons → Analysis → Accuracy.
Key uses exact-match deciles; BPM uses the corrected tempo labels for ±4 % and
half/double tempo deciles. Lower edges are inclusive, shared edges choose the
higher band, rounded gaps use the preceding band, and valid scores beyond the
measured sample use the end bands. Missing or invalid scores have no numeric
accuracy line. This measures test-set accuracy, not certainty for an individual
song. Calibration changes require a version bump.

## Calm to intense arousal

`arousal` is an additive nullable number in [0, 1] on each album-listing track
(also in its `analysis` object) and `GET /api/analysis/{relPath}`. Existing mood
words remain unchanged. It describes relative intensity within this server's
analysed library, not happiness, sadness or a calibrated emotion probability.
Members receive the same value on their existing scope-filtered rows.

`AROUSAL_RULE_VERSION = 1` uses only stored computed energy, pulse and BPM;
no audio decoding, helper update, model, file tags or corrections are involved.
For N eligible songs, let R(x) be the zero-based average rank of x among equal
values, divided by N−1. A one-song population has rank 0.5. Compute:

```
score = 0.50 * R(energy) + 0.30 * R(pulse) + 0.20 * R(bpm)
arousal = R(round(score, 12))
```

Energy has the largest weight; tempo has the smallest to reduce sensitivity to
half/double-tempo estimates. The last ranking spreads combined scores across
the axis instead of clustering them around the mean. Ties retain their average
rank, including identical songs; paths never break a tie. With distinct scores,
each decile holds approximately 10% of songs. A population dominated by ties or
fewer than four songs cannot guarantee the 30% distribution acceptance bound.
Distribution checks therefore use varied populations and also test ties
explicitly rather than inventing intensity differences.

Eligible rows have finite nonnegative energy/pulse, positive finite BPM, and no
`missing_since` mark. Incomplete, invalid and missing-file rows return null.
Brightness and confidence do not participate. Stale analyses retain their
stored cues until replaced, as the existing mood field does. Arousal values may
shift as the analysed population changes; they are not comparable across nests.

The analysis store adds the column through a numbered migration. Startup
recomputes it when the rule version changes. Measurement or population writes
persist a dirty marker; the next helper result batch or background analysis
scan refreshes all affected ranks. Startup also repairs interrupted batches.
Values, the version and dirty-marker removal commit atomically. Ranking changes
advance the listing revision; reads only project stored values and never enqueue
or rank songs. Corrections, revisions, timestamps, tags and audio stay intact.

## Owner run controls

`POST /api/analysis/runs` accepts `requestId` (1–128 characters), `mode`
(`new`, `outdated`, `all`), `scope` (`library`, `selection`, `song`) and
`relPaths`. Library scope omits paths, selection accepts 1–500 paths, and song
scope requires exactly one. These routes require an owner account. Repeating a
request id returns the original response, including after completion or cancellation.

`new` fills missing analysis and changed files. `outdated` also refreshes older
engine versions. Both skip final failures and current songs. `all` explicitly
rechecks every present song, including failures and current songs. Corrections,
confirmations and foreign tags survive every mode. Unknown, missing, ghost and
outside paths are reported in `skipped`; duplicate paths are counted once.

The response is `{run: {id, jobId, mode, scope, size}, queued, joined, skipped}`.
When nothing qualifies it returns `run:null, queued:0`. One live library run is
allowed: a second request with the same mode joins it; a different mode receives
409 `run-in-progress`. Other typed 409 codes are `library-unavailable` (including
empty or unreadable mounts), `migrating`, `scan-busy` and `no-helper`.

Library runs use the `library` lane and carry a persistent fence against nest CPU
execution in every mode. Re-runs (`outdated` and `all`) require a capable real
helper online at request time. If the helper goes offline afterward, work waits
with `helpers-offline`. New acquisitions use `new`; song and selection actions
use `now`, upgrading already queued items in place. Joining a library run keeps
its nest fence even when an owner song action promotes the item.
Selections larger than 25 cannot use nest
fallback. Smaller selections and songs retain the usual 600-second fallback
delay, with a 30-second rest between consecutive nest batches of an owner run.
Eligible job kinds rotate fairly within each lane.

`GET /api/analysis/runs/preview?mode=all` uses the same eligibility rules without
writing, sweeping ghosts or enqueuing. It accepts the same scope and repeated
`relPaths` query parameters. It returns `size`, `waiting`, `outdated`, `failed`,
`correctionsKept`, `confirmationsKept`, `skipped` and nullable `estimateSeconds`.
Kept counts count fields; a fixed value equal to the stored computed value is a
confirmation. Estimates use measured helper time per minute of audio and known
audio durations; they are null until both are available.

`KROBI_ANALYSIS_AUTO` defaults to true. Owners change it through
`PUT /api/server/config` with `{"changes":{"KROBI_ANALYSIS_AUTO":false}}`.
The setting is persisted before it takes effect under the producer lock.
Process environment pins report `editable:false, source:"env"` and refuse writes
with 409 `env-locked`. This switch covers completion-listener arrivals, files
first seen after the selected root's first complete scan, and analysed files
changed in place. Off cancels queued automatic arrivals while leases and owner
runs continue. Re-enabling queues pending arrivals on the next 30-second scan.

Existing songs without analysis remain idle until the owner presses **Analyse now**.
Changing roots establishes a new durable baseline. Engine changes never enqueue
automatic re-analysis: older results stay available with an **Outdated** status
until the owner requests a run. The nest has no schedule; its CPU, memory,
thermal, placement and pause guards still apply. Helper computer hours are unchanged.

The background loop makes one pass per boot and another only when folder
signatures or the arrival switch change. Each pass considers changed folders
plus remembered arrivals, including while automatic analysis is off; it never
walks an unchanged library periodically to enqueue a whole-library pass.

Cancel through `POST /api/jobs/{jobId}/cancel`. Helpers stop on heartbeat and
late results lose their lease. Applied values remain; joined items owned by
other jobs continue. Cancelled owner work is suppressed at that signature until
another explicit run requests it or the file changes. Cancelling a terminal job
returns 409. Automatic work can be stopped with its corresponding automatic-analysis switch.

Summary includes integer `outdated` (songs in the `outdated` category with a stored
engine version older than the current engine), `waiting` and nullable `run` with `id`, `jobId`, `mode`, `scope`,
`size`, `done`, `failed`, `waiting` (helper reason), nullable `etaSeconds` and
`counts`, under the existing ETag. Progress includes joined songs. Counts record
`queued`, `joined`, skipped reasons, `same`, `changed`, `toEstimated`,
`toConfident` and `failed`; confidence flips count fields. Listing and per-song
wire shapes retain their meanings.

Run intent, membership and initial responses persist in the analysis store
before queueing. Restart recovers leases and reconciles run/job outcomes,
including interrupted registration. File changes replace an item within its
original job and retain its run, force flag and lane. Every applied result
records `checked_at`, helper identity and acceleration. Changed values also
update `analyzed_at` and write a before-value history row in the same transaction.
History lasts at most three runs and thirty days; it has no undo action.
Analysis tag edits have their own 5,000-entry journal budget so they cannot
evict people's tag-edit undo history.

## ReplayGain

Engine version 2 measures EBU R128 loudness with ffmpeg's `ebur128` filter,
including true peak, on the original channels before the mono key/tempo branch.
Audio is decoded once. `trackLufs` is integrated LUFS (null for gated silence),
`truePeak` is linear full-scale amplitude, and `lra` is LU. `decodeSeconds` records
CPU wall time for decoding plus loudness. `loudnessBlocks` contains 400 ms
K-weighted windows at 100 ms intervals above the −70 LUFS absolute gate.
These additive measurements live in the analysis store, without changing audio.

The nest combines the album's windows and applies one relative gate, then
computes gain against −18 LUFS. It never averages track gains. Albums need all
current track signatures, including folded disc folders; an incomplete or changed
album has no computed album gain. Album gain and maximum true peak are persisted
with the track records. Listings revalidate album membership and signatures.

Finite existing `REPLAYGAIN_*` values win per field. `R128_TRACK_GAIN` and
`R128_ALBUM_GAIN` use signed Q7.8 at −23 LUFS, converted by adding 5 dB for the
−18 LUFS playback reference. OpenSubsonic songs expose `replayGain` with
`trackGain`, `albumGain`, `trackPeak`, `albumPeak` and `baseGain`; the last field
is decoder output gain (zero except for Opus headers), not the loudness target.
`GET /api/analysis/{album}/{file}/replaygain` supplies the same values for saved
queues and playlists without embedded analysis. It requires authentication and
returns 404 for a missing or out-of-scope song.

Desktop Settings → General offers **Volume levelling: Off · Track · Album**,
defaulting to Track and persisted on this device. Album mode uses album gain
while playing an album in order, and falls back to track gain for shuffle,
playlists and manual queue changes. Missing gains use unity. Gain is applied in
Web Audio independently of the volume slider, with a measured-peak clipping
cap. Decoders already apply Opus output gain; the desktop does not add it again.

**Save analysis in the files** controls all write-back. Gain tags are written
only through the tag writer after the store commits, preserving every existing
gain tag. MP3/FLAC/OGG/MP4 use ReplayGain tags; Opus uses R128 gains without RG
peak comments. BPM/key confidence and ownership rules remain unchanged. Engine
version 1 songs become outdated and are re-analysed only by an owner run.

Reference definitions: [ffmpeg ebur128](https://ffmpeg.org/ffmpeg-filters.html#ebur128),
[OpenSubsonic ReplayGain](https://opensubsonic.github.io/docs/responses/replaygain/),
[Opus gain tags](https://www.rfc-editor.org/rfc/rfc7845#section-5.2.1).
