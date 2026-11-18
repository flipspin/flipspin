# Working on shared contracts

Paths below are repository-relative. This directory owns rules every Flipspin
client must answer identically: one JSON case file per feature, read directly
by each consumer's own suite. A clean checkout does not need sibling phone
repositories to run its local suites. Phone consumers run in their own repos.
Change cases first, then implementation and all affected consumers.

## Case map

| File | Rule | Consumers and enforcement |
|---|---|---|
| `contracts/data-root.json` | Flag, environment, legacy-data and OS root resolution | `backend/tests/unit/test_data_root.py`; `helper/tests/test_data_root.py`; Rust `src-tauri/src/data_paths.rs` tests |
| `contracts/lyrics-offset.json` | LRC offset sign, playback clamp, tag replacement | Backend lyrics-route tests; `renderer/src/lyrics/lrc.test.ts`; phone readers pending, not enforced yet |
| `contracts/replaygain.json` | ReplayGain precedence, album selection and playback gain | Backend loudness tests and renderer levelling tests; phones frozen readers |
| `contracts/analysis.json` | Per-field correction/tag/computed precedence and confidence | `backend/tests/unit/test_analysis_step0.py`; renderer reader pending, not enforced yet |
| `contracts/change-events.json` | SSE hello/change shapes, reconnect, scoping and limits | `backend/tests/unit/test_change_bus.py`; `backend/tests/integration/test_change_events.py`; `renderer/src/data/changes.test.ts` and native stream tests |
| `contracts/change-areas.json` | Area revisions, read routes and renderer query-key prefixes | `backend/tests/integration/test_conditional_reads.py`; `renderer/src/data/changes.test.ts` |
| `contracts/library-date-added.json` | Immutable first-seen dates across tag writes and moves | `backend/tests/integration/test_date_added.py`; other client readers pending |
| `contracts/library-keys.json` | Two-segment flat/nested keys and reserved root album | `backend/tests/unit/test_library_paths.py`; `renderer/src/library/libraryKeys.test.ts` |
| `contracts/resolver.json` | Title folding, move action, replacement confirmation, row control | `renderer/src/browse/resolve.test.ts`; phone native contract suites |
| `contracts/album-page.json` | More-by-artist album selection | `renderer/src/albums/LibraryAlbumPage.test.tsx`; phone native contract suites |
| `contracts/playlist-page.json` | Playlist song/duration/download facts line | `renderer/src/playlists/playlistFacts.test.ts`; phone native contract suites |
| `contracts/sign-in-code.json` | Alphabet, six characters, TTL, expiry display | Backend account tests; `renderer/src/auth/signInCode.test.ts`; phone readers pending, not enforced yet |
| `contracts/setup-link.json` | Setup link make/parse/refusal/redaction and installer output | `backend/tests/unit/test_setup_link.py`; `scripts/deploy-release.test.mjs`; `renderer/src/setup/setupLink.test.ts` |
| `contracts/one-account.json` | Forbidden UI vocabulary and Admin/Normal role labels | `renderer/src/settings/oneAccount.test.ts`; phone readers pending, not enforced yet |
| `contracts/remote-access.json` | Typed domains, probes, address selection, reachability, elapsed time, outside classification | `backend/tests/unit/test_remote_access.py`; `renderer/src/remote/rules.test.ts`; Rust tests for pick/probe; phone native contract suites |
| `contracts/delete-account.json` | Delete facts, action label, library-delete option, sizes, toast | `renderer/src/settings/deleteAccount.test.ts`; phone native contract suites |
| `contracts/compute-placement.json` | Compute pause, placement, memory, hours and charging decisions | `backend/tests/unit/test_compute_placement.py`; `renderer/src/settings/background/BackgroundWork.test.tsx` |
| `contracts/source-plugin.json` | Source protocol, status/actions, URL dispatch, installation and data lifetime | `backend/tests/unit/test_source_plugin.py`; installer integration tests in `backend/tests/integration/test_source_installer.py` |
| `contracts/helper-protocol.json` | Capability matching, ten-minute leases, heartbeat, expiry, three attempts, stale results, stop | `backend/tests/unit/test_helper_protocol.py` |
| `contracts/helper.json` | Helper states, waiting, acceleration, matching and measured speeds | `renderer/src/settings/helper.test.tsx` |
| `contracts/server-config.json` | Settings provenance, locks, atomic batches, concurrency and restart | `backend/tests/integration/test_server_config.py`; `backend/tests/unit/test_server_capacity.py` |
| `contracts/extensions.json` | Manifest validation, protocol refusal and kind/runtime mapping | `backend/tests/unit/test_extensions.py`; `helper/tests/test_plugins.py` |
| `contracts/offline.json` | Per-device offline intent, cache, playback and logout rules | `renderer/src/offline/Offline.test.tsx`; phone readers pending, not enforced yet |

The phone suites are the iOS native check harness and Android native contract
tests. Their code and toolchain instructions belong to those repos. Keep local
documentation honest about which parts each suite reads.

## Wire snapshots

`contracts/wire/` stores whole response bodies decoded by clients: browse,
ownership, acquisition, library moves, accounts, analysis and other shared
payloads. These complement OpenAPI: an unmodeled FastAPI dictionary can change
without changing its schema. Do not rename/delete keys, change types or reorder
positional answers.

To accept an intentional compatible body change, run from backend:

```sh
UPDATE_WIRE_SNAPSHOTS=1 ../.venv/bin/python -m pytest tests/integration/test_wire_snapshots.py
```

Review the diff in contracts/wire and make the phone suites decode it. For
declared schema changes, run the OpenAPI snapshot test with UPDATE_API_SCHEMA=1,
then regenerate renderer types with `npm run api:generate`. Never regenerate
snapshots simply to conceal a regression.

## Adding or changing a rule

Use small deterministic input → expected cases, preserving existing cases when
adding a feature. Keep semantics out of platform-specific test copies. Prose
explaining the feature belongs in docs; expected answers live here. Add the
consumer to this map, or mark it pending.

For lyrics, the release ships sync only, with no transcription. Timing
correction is an `[offset:]` tag (+ = sooner), written through
PUT /api/lyrics/{album}/{file}/offset. Cover zero/removal, replacement, sign and
playback clamp in the shared cases.

## Testing

Run the relevant backend pytest file and renderer Vitest file, then the affected
native tests via `make test-rust`. `make test` and `npm test` cover the local
backend/renderer consumers in full. Run external consumer suites in their own
checkouts; do not claim those passed from local snapshots alone.

## What guards these rules

| Rule | Guard |
|---|---|
| Shared feature semantics | Consumer suites in the case map; pending consumers not enforced yet |
| Whole response bodies and declared schemas | `backend/tests/integration/test_wire_snapshots.py`; `backend/tests/integration/test_response_contracts.py`; `backend/tests/integration/test_openapi_schema.py` |
| Intentional compatibility review | Not enforced yet; review snapshot diffs and run affected decoders |
| Case-reader completeness | Named consumer loaders; complete coverage of every JSON file not enforced yet |
| Lyrics offset semantics | `contracts/lyrics-offset.json` through backend lyrics and renderer LRC tests |
| External client parity | Run each external suite in its own checkout; not enforced by local tests |
