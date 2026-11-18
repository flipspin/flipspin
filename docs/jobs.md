# Jobs and helper leases

## Ledger and live progress

`infra/jobs/ledger.py` stores job intent, attempts and per-item outcomes in SQLite.
State and attempt checks fence late completions after cancellation or retry.
The process-local progress tracker is a disposable view; actions use ledger state.
Register work before returning its progress id so an immediate subscriber can
find it. Completed counts attempted items; succeeded and failed describe outcomes.
Terminal ends polling. Active-download listings may retain recently finished
entries for a caller-selected interval, independently of eventual cache cleanup.

Queued work survives restart. Recovery distinguishes resumable queued items from
interrupted work and reconstructs progress from durable outcomes. An explicit
retry records a new ledger attempt; it does not let the prior attempt publish.
Feature adapters register job kinds, result handlers and wire views over the
shared mechanism rather than defining another lease policy.

## Change notifications

`GET /api/events` receives writer-driven area nudges. Full and targeted album
scan publication bumps `library`; analysis repository commits bump `analysis`
when the visible SQL listing revision advances. Ledger version writes and live
phase updates call an injected notification callback. Helper presence and work
transitions bump `helpers` and `jobs`.

Holding streams open runs no provider polling or safety resync. Providers supply
revisions for hello snapshots and nudges only. Time-based helper expiry is
reported by the existing reap path, throttled to once per 60 seconds and also
called by job maintenance. The stream's 500 ms debounce, connection and queue
limits, 15-second heartbeat and reconnect behavior remain unchanged.

## Claims, leases and requeue

Helper leases live on ledger item records. Claims use a full SQLite transaction
with the writer reserved before selecting work, preventing separate connections
from claiming the same item. Only one live lease is allowed per authenticated
device across kinds. The current lease and holder authorize heartbeat and result
publication; an old job id alone is insufficient. Accepted result receipts make
repeated submissions idempotent. Feature publication must validate and stage a
complete result before making it visible.

A lease without heartbeat for ten minutes is eligible for requeue on claim.
Work gets at most three lease attempts. A final pipeline verdict remains failed;
a recoverable accident can requeue. Server restart invalidates leases while
retaining rows. Graceful helper departure releases work promptly without refunding
attempts. Cancellation, replacement and lease loss stop publication even if a
child eventually finishes. See [the helper wire reference](stems.md#worker-side-the-helpers)
and `contracts/helper-protocol.json` for request and response shapes.

## Helper process lifetime

Helpers dial out, fetch inputs, run a child and submit results. Heartbeats run on
an independent timer because model execution can produce no output for extended
periods. A stop response terminates the child and discards its output. Network
errors back off; they are not evidence that the song itself failed.

Each pipeline runs in a separate process so model and accelerator caches are
released on exit. The idle agent imports no pipeline. One agent lock per device
lets a newly started agent replace an orphan with current configuration, and
parent-death supervision prevents accumulation after app crashes. On termination
no partial output is posted; lease expiry provides recovery. Cancellation covers
the child process group rather than leaving descendants running.

The shared helper API chooses work on the server. A 404 falls back to legacy
feature routes, preserving lyrics-first polling for older servers. Other HTTP
failures keep their retry semantics. The release exposes lyrics sync only;
optional transcription support does not enable it in release packaging.

A helper below the protocol floor receives a successful claim response with
`stop: true`, `reason: "too-old"` and `minimum: "0.10.0"`, without a lease.
Legacy lyrics responses also retain their empty `jobs` array. Refusal leaves
presence visible and consumes no attempt. Existing agents idle between polls
instead of failing and restarting. Helper inventory and compute rows expose
`version`, `minimumVersion` and `versionState` (`current`, `update`, `too-old`).
The floor is independent of the shipped release: result retries and redirect
authentication improvements do not require a new claim/result envelope.
