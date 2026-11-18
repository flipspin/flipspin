# Working on the compute helper

Paths are repository-relative. `helper/krobi_helper/cli.py` exposes krobi-helper;
agent.py handles claims and child lifetime, protocol.py emits JSON lines,
acceleration.py reports capabilities, and plugins.py discovers extensions.
`helper/krobi_helper/kinds/` separates lyrics, stems and analysis pipelines.
`helper/compat/` forwards the old package/CLI for one release. Keep new code
under the current package.

## Process and wire discipline

Heavy ML belongs here, never under backend/app. Import models lazily so check
can answer in seconds using module-spec probes. The agent must stay light while
idle; run work in children so accelerator memory is released. Keep stdout for
protocol events only; diagnostics and library progress go to stderr. Use one
agent per device, parent-death supervision and process-group cancellation.

Dial out: claim from POST /api/helpers/claim, heartbeat independently of model
output, and publish through the matching job result endpoint with its lease.
An empty queue is 204; a stop response means discard work and terminate the
child. Never publish under a lost lease. Ten minutes without heartbeat requeues
work, at most three attempts; pipeline verdicts may be final while network
failures back off. Keep legacy route fallback for old servers. Use the enrolled
helper credential rather than the user's desktop token.

## Lyrics and stems

The release ships lyrics **sync only, with no transcription**. Known text is
aligned; Whisper is not part of that path. The optional transcription extra in
`helper/pyproject.toml` is not installed by the release installer. Preserve
line-level LRC and confidence information; do not emit word tags that clients
would display literally. The timing correction is an `[offset:]` tag (+ = sooner),
written through PUT /api/lyrics/{album}/{file}/offset on the server; do not bake
the correction into line stamps.

Keep the numpy CTC alignment behavior rather than substituting a library
forced-align implementation without comparison. Reuse fresh vocals when
available. Stems output is the manifest and four Opus files; bounded uploads
and atomic publication belong to the server. Use conservative separation batches
to control accelerator memory; chopping points still require client fades.

## Analysis and extensions

Analysis has a separate lightweight extra (KeyFinder and ONNX Runtime CPU),
without requiring the engine extra. Decode once, preserve claimed size/mtime
signatures, return per-field confidence and finite measurements, and isolate
per-item failures inside a batch. Use the pinned model and checksum; do not
introduce export-only TensorFlow dependencies at runtime. Protocol details and
feature definitions are in `docs/analysis.md`.

Register optional extensions via krobi_helper.plugins entry points, keeping
registration lightweight. The old group is read for one release; duplicates
prefer the new group. Keep extra wheels and plugin types outside the clean host
release, and preserve the union of selected install extras during upgrades.

## Testing

Run `make test-worker` for `helper/tests/`. Pure tests need pytest and numpy,
not downloaded models; use the backend virtualenv instead of installing every
ML extra. Changes to acceleration or real pipelines also need representative
hardware/model runs, explicitly reported separately.

## What guards these rules

| Rule | Guard |
|---|---|
| Package migration and extension discovery | `helper/tests/test_migration.py`; `helper/tests/test_plugins.py`; module placement not enforced yet |
| Lightweight processes and protocol stdout | Backend no-ML import contract; `helper/tests/test_agent_process.py`; `helper/tests/test_pipeline_pure.py`; cold-probe latency not enforced yet |
| Claims, leases, fallback and results | `backend/tests/unit/test_helper_protocol.py`; `helper/tests/test_helper_api.py`; `helper/tests/test_agent_stems.py` |
| Lyrics alignment, stems and selected extras | `helper/tests/test_align_pure.py`; `helper/tests/test_stems_chopper.py`; `helper/tests/test_addons.py`; hardware quality and peak memory not enforced yet |
| Analysis models, signatures and batches | `helper/tests/test_analysis.py`; backend analysis-helper integration tests; model accuracy not enforced yet |
| Clean packaging and release fingerprint | `scripts/check-worker-release.cjs`; packaging review; complete distribution contents not enforced yet |
