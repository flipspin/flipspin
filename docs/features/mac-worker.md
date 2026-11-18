# Desktop helpers

A supported computer running Flipspin can process lyrics sync, stems and analysis
for its nest. This includes a computer hosting its own nest, whether the desktop
app starts the bundled server or adopts an existing local server. Desktop helpers
use Apple Silicon (MLX), Nvidia (CUDA) or CPU according to their installed engines
and hardware. Lyrics sync aligns known words; the release offers no transcription.

## Setup and identity

Sign in with an owner account. First run’s Engines step installs the selected
engines on this computer and enables its helper. Settings → Engines manages the
same installation and the “Help the nest” switch. Lyrics sync requires a
non-commercial-use acknowledgement; Analysis can be installed independently of
the shared lyrics/stems engine. Engine installation and repair report progress
on this computer.

The shell enrolls a separate helper device with `POST /api/me/devices` and
`helper: true`. It uses the computer’s display name and the existing account’s
owner authorization. The helper uses its own device token, never the desktop
account token. Rust stores the credential separately for each nest; local mode
uses a stable local identity. Credentials never cross the renderer boundary.
Only an owner account’s helper device token may use the helper API, including
requests over loopback. Revoking a helper device stops that helper alone.

Settings → Helpers lists this computer as an ordinary helper by its name,
with its engines, version, state, measured speeds and per-device limits. Several
helpers can process at once. The server’s capped CPU worker has a separate nest
row; on systems without Linux cgroups it cannot claim, while the desktop helper
can still process for the local nest.

## Work and policy

The helper connects out to the selected server address. For a local nest this
is the local server address; for a remote nest it is the active selected
transport. It claims one job from `/api/helpers/claim`, heartbeats independently
of model output, and publishes through `/api/helpers/jobs/{id}/{result,heartbeat}`.
It falls back to the legacy feature routes on a 404 from an older server.
See [jobs and leases](../jobs.md) and the [helper protocol](../../helper/README.md#agent-protocol-0100).

All desktop helpers, including this computer hosting the nest, follow the same
pause, memory, pace, charging and hours rules in
`contracts/compute-placement.json`. Lyrics sync and stems require 8 GB of memory;
Analysis has no shared-engine memory floor. Desktop helpers use ordinary helper
placement and schedules. The server’s own CPU worker retains its separate CPU
cap, thermal limits and nest placement rules. If both can process, the shared
lease queue gives each job to only one holder.

## App lifetime

The helper runs while Flipspin is open and its switch is on. It starts again
with the app and after authentication changes, reusing the enrolled device when
it belongs to the current account. It is a child process, with parent-death
supervision and process-group cancellation for its work children.

Keep-awake is held only while a job runs. Before sleep the helper sends goodbye
with reason `sleep`; on quit it sends `quit` and stops. The shell stops the helper
before shutting down its owned local nest, so goodbye can reach the server.
Externally managed servers keep their own lifetime. Nothing installs a separate
background service.

The nest reports working, idle, asleep, closed, offline, revoked and outdated
states. Session identities prevent an old process’s goodbye from closing a newer
session. Network denial and credential rejection appear on this computer because
the helper cannot deliver them to the nest.

## Installation and updates

The app bundles pinned uv and uses managed CPython. Upgrades preserve the union
of selected engine extras and reuse cached models. Repair prefetches models
without rebuilding the environment or changing credentials. Helper releases
carry a checked source fingerprint; helper package changes require matching
versions and an updated `helper/release.json`. The protocol floor and version
status are described in [background work](background-work.md#helper-versions).
