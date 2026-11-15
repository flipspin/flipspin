# Library scans

The server publishes one library snapshot in the background. Listings keep serving
that snapshot, including during a full rescan. Conditional album-listing requests
use cached, scope-specific response bytes and a strong ETag; they do no disk
discovery, tag reads, cover encoding or response serialization on a cache hit.
Membership changes use a different cache entry, so an owner's validator cannot
validate a member's response.

The previous cache depended on the modification time and size of the analysis
SQLite database and WAL, a counter advanced by arbitrary tag-memo misses, and a
five-minute expiry. Analysis bookkeeping, explicit invalidations and unrelated
readers could therefore rebuild the whole listing. The conditional-response
middleware only computed an ETag after that work had finished.

`music-scan.sqlite`, beside the analysis store, is a disposable music-owned cache:

- `folders`: each physical folder's signature of audio/image names, sizes and
  nanosecond mtimes; disc folders and legacy cover directories follow the existing
  album grouping rules.
- `tags`: each file's parsed tags, keyed by its path, mtime and size.
- `snapshots`: the last completed album snapshot and scan time/duration per root.
- `requests`: full-rescan and explicit-deletion intent retained until a pass
  succeeds, including across interruption and restart.

Only changed folders rebuild. Within them, unchanged files reuse their tag memo.
A full rescan bypasses both signatures and tag memos. Analysis has a separate,
logical listing revision: visible value/ownership changes advance it, while
bookkeeping and unchanged updates do not. A refresh reads analysis and tag
ownership in one batched query, rather than opening three connections per song.
Analysis-only changes project onto cached tracks without reopening tags.

The application starts and stops its worker with its lifespan. Standalone
maintenance consumers can call `refresh()` explicitly; the repository retains
its synchronous offline `scan_albums()` compatibility entry point. Hosted reads
always use the published snapshot. A cold ownership query waits for the initial
background snapshot so acquisition cannot mistake existing songs for misses.
The library revision is an in-memory counter, bumped once when a full or targeted
scan publishes. Together with the process boot id it validates catalog, Home and
lyrics responses without filesystem probes. Listings and lyrics read the published
snapshot while the watcher follows the current root; without a live watcher,
unconditional reads retain the synchronous freshness check.

Native filesystem hints wait for five quiet seconds before a change scan.
Hidden folders, temporary files, sidecars, file-open events and directory-mtime
noise do not schedule scans. One worker coalesces requests; a full request wins
over a queued change scan. Startup runs a full pass. Periodic discovery runs every
30 minutes with a live watcher on the current root, or every five minutes without
one. Watchdog overflow and error reports request a full recovery pass. Watcher
liveness is rechecked at least every five minutes, including emitter threads;
a detected failure also requests a full pass. `GET /api/library/scan` exposes the
effective interval as `intervalSeconds`, alongside `watching`.
Unchanged periodic checks do not log a real scan. Real scans emit one
INFO line with their reason, full/change mode, changed-folder count and duration;
a failed pass includes its reason and duration too.

An unavailable or unexpectedly empty root retains the last good snapshot. An
explicit deletion can publish an empty library, including after a restart before
the deletion was published. The existing analysis sweep
continues to own missing timestamps, grace periods, correction retention and
purging; the scan cache does not delete those facts. Wire snapshots, phone code,
metadata writers and analysis computation are unchanged.

Owners can use **Settings → Library → Scan for changes** or **Full rescan**.
`GET /api/library/scan` reads status, and `POST /api/library/scan` accepts
`{"full": false}` or `{"full": true}` and returns 202. Both routes require an
owner. Existing listing fields are unchanged; the new endpoint and models are
additive.

## Library keys

Media, personal-library rows, lyrics and stems share a two-segment album/file
identity. Nested physical directories fold into a segment with U+2215 DIVISION
SLASH: `Artist/Album/song.mp3` becomes album `Artist∕Album`, file `song.mp3`.
Disc folders fold into the file key; root tracks use the reserved root album.
Flat-library keys retain their meaning. Encoded slashes cannot provide this
boundary because routing decodes `%2F` before matching segments. Literal U+2215
names are tried first at every depth; splitting follows physical boundaries.

## Catalog ownership

Catalog ownership uses the shared artist/title normalizer and a duration veto.
Remaster packaging may fold, but live, remix and instrumental qualifiers identify
different recordings. A duration mismatch is returned with a reason rather than
silently claiming the requested cut is present. Local files without recording
identifiers rely on this conservative heuristic; clients do not duplicate it.

The index follows the published snapshot revision, not tag-memo misses or SQLite
bookkeeping. Acquisition bursts keep using the current index while work is in
flight. Completion marks it dirty and restarts a short settle window. A query
after the burst waits out that window on its worker thread and rebuilds once.
This avoids repeating the same index work for each file while still updating
owned markers after the final acquisition.

## Track relocation

Moving a recording repoints all account rows, merging an existing destination
membership, along with listening events, receipts, counter baselines, playlist
paths, lyrics, analysis and stems. Replacement keeps the old audio until the new
download succeeds. Move preserves lyrics and sidecars; replacement removes old
lyrics because another cut's timings cannot be reused. Completion listeners fetch
the replacement's lyrics. Snapshot refresh and ownership invalidation expose the
new paths through the normal scan machinery.

## Listing covers

Inline base64 artwork dominates large listing payloads and is especially costly
over remote upstream links. Clients loading individual cover resources can use
`covers=false`, which returns null cover fields without changing track metadata.
The inline default remains for clients that still consume it.

## Verification

The scan tests cover restart reuse, in-place edits, image/disc changes, full
bypass and recovery, unrelated SQLite/memo activity, constant analysis-query
cost, coalescing, filesystem debounce and timer fallback, cold ownership,
failed/unavailable roots, explicit last-file deletion, nonblocking HTTP reads,
ETag variants, member scoping and owner authorization. Renderer tests exercise
both commands, translations, busy/error/older-server states and completion
refreshes. UI screenshots use the real Settings components with fixture data.

The reproducible benchmark is `scripts/benchmark-library-scans.py`. Use a
memory-backed filesystem and an empty state directory for each checkout:

```sh
python scripts/benchmark-library-scans.py --tree "$BENCH_ROOT/Music" \
  --state "$BENCH_ROOT/state" --prepare --listing-polls 100
```

For a baseline checkout, pass `--backend "$BASELINE_BACKEND"` and a separate
state directory. Each tree contains 50,000 valid, 46-byte WAV files in 500 folders.
The warm baseline explicitly invalidates the album-list cache to measure a scan,
rather than its cached getter. The incremental backend explicitly requests a
change scan. The changed case rewrites one file in one folder. The script asserts
track counts and, on the incremental backend, tag reads of 50,000 / 0 / 1 / 0
for cold / warm / changed / restart. Scan timings exclude repository construction;
restart tag-memo loading is therefore outside the timed pass.

Measurements and acceptance results are recorded in the task evidence report.
