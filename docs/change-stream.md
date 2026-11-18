# Desktop change propagation

The native shell owns one authenticated `/api/events` connection for the app.
Its dedicated HTTP pool shares vault-backed custom headers with JSON forwarding,
but never acquires a JSON proxy permit. It forwards `server:hello`,
`server:changed` and `server:stream` to every window. Credentials stay in Rust.
`server:stream-snapshot` supplies the latest hello and stream state to a newly
mounted renderer; listeners register before reading that snapshot.

The stream reads SSE frames incrementally, including comment heartbeats. A
45-second read deadline detects missed heartbeats. Disconnects reconnect with
full exponential jitter up to 30 seconds. Native network, wake and focus signals
reset pending backoff. A healthy stream stays open across focus changes. HTTP
401/403 pauses retries until the credential context changes. Sign-out drops the
old response immediately. Stream state describes this transport; the existing
connection owner continues to decide server reachability.

`renderer/src/data/changes.ts` imports the area-to-key mapping from
`contracts/change-areas.json`. Changes invalidate active queries only. While
unfocused, queries and imperative stores accumulate dirty areas; focus flushes
each affected reader once. Hello compares opaque revisions by equality and
resyncs all displayed queries on a new boot, including the initial connection.
An in-flight snapshot is cancelled before refetch so it cannot swallow a nudge.
Legacy stores use `watchChanges` rather than owning additional streams.
Browser development uses a direct EventSource with the existing browser auth
helper. The small `streamStore` is available for status UI consumers.

The timer ratchet drops from 40 to 18 registrations, including the shared
progress wait. Idle polling is removed from library refresh, identity recovery, sign-in
requests, jobs/acquisitions, lyrics state/jobs, analysis/compute, stems listings,
server host/update, attention, library health, analysis previews, upload space
and local helper status. Static facts still read on mount or explicit refresh;
local helper changes already have native events.

`renderer/eslint-poll-baseline.json` documents the remaining progress and
handshake waits. ESLint rejects new timer owners and the ratchet test enforces
the per-file counts. Download percent, scans/uploads, tag edits, lyrics sync,
matching, pending stems and restart progress have no equivalent stream nudge
for their intermediate values. The unsigned-in code-approval wait and first
Subsonic request wait also have no event yet. All retained waits use the common
foreground policy; no idle data timer remains.
