# Background work

Settings → Helpers shows shared work and the computers that
can do it. The waiting badge counts queued lyrics sync, stems and analysis items.
Work rows show the oldest queued item, current workers and the reason work is
waiting. Computers report their engines, measured speeds and resource limits.
Only an owner can read or change household compute settings. Members retain
their personal library scope and do not request this summary.

Placement is saved per kind: Helpers only, Helpers then the nest, or Anywhere.
Analysis defaults to Anywhere; lyrics sync and stems default to Helpers only.
The server refuses nest placement when its worker memory allocation is too
small. The existing helper ranking, queue lanes and fairness still select work.
Whole-library analysis requires a helper and never uses the nest CPU.

Computer settings are keyed by enrolled helper device, independently of its
session. Fast uses normal process priority. Gentle limits CPU threads and lowers
child-process priority; the nest also retains its explicit CPU cap and thermal
safeguards. Off prevents claims. Hours use the helper's reported local UTC
offset; older helpers use the server's clock. An overnight window belongs to
the day on which it starts. The nest has no schedule.
Existing process-environment pins for nest CPU and temperature remain locked.
Charging-only is offered when the helper can report a laptop power state.

Pause is available per kind, per computer and for all work. A pause invalidates
active leases and defers their unfinished items without consuming another
attempt. Completed results remain. Resume makes those items eligible again.

Add-ons manages installed engines on the current computer. Install everything
includes Engine, Analysis and Stems when supported. Lyrics sync is separate:
its MMS model uses CC BY-NC 4.0 and installation requires a non-commercial-use
acknowledgement. Per-feature Use controls claiming without deleting the engine.
GPU installation and status use the existing GPU pack layer.

## API

- `GET /api/compute/summary`: owner-only kind policies, queue counts, active
  work, waiting reasons and computer inventory/limits.
- `PUT /api/compute/kinds/{kind}`: placement, pause and library-pass policy.
- `PUT /api/compute/computers/{identity}`: complete validated device limits;
  use `nest` for the nest's row.
- `PUT /api/compute/pause`: household pause.
- `GET /api/helpers/limits`: an enrolled helper reads its own limits.

The tables `kind_policy`, `worker_limits` and `compute_state` live alongside
the lease queue in the jobs database. The old nest fallback, lyrics engine
mode and stems background switches seed these tables once. Subsequent boots
preserve the new settings. The old configuration keys and helper protocol
remain available for one compatibility release; their controls have moved out
of Advanced, Stems and the former Helpers page.

Analysis uses the existing runs, preview, summary, job cancellation, automatic
analysis and tag-writing routes. New or outdated is the default; Whole library
has its own count and measured estimate. Corrections and confirmations are kept.
Estimates link to review and Accuracy links to the existing measurements.

## Helper versions

Settings → Helpers shows every computer's helper version, including the nest.
Patch gaps stay silent. A minor or major gap below the shipped helper shows
“Update Flipspin” in an info tone; the helper continues taking work.

The protocol floor is 0.10.0, the first unified claim, heartbeat and result
API. Older helpers remain listed but cannot claim work. Their status says
“Too old for this nest”, with the required version in its tooltip, and the
owner's Overview includes a to-do. The update action opens the existing Flipspin
release flow on the computer that needs updating. The nest has no hours fact.

Settings → Performance controls “At a time per source” (1–4, default 2) and
“Jobs at a time”. Light sets both to 1; Normal, the suggested profile, sets both
to 2. Custom retains individually chosen values. These profiles change only
fetch and job limits; they do not set retired analysis capacity.
