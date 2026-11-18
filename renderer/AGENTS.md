# Working on the renderer

Paths are repository-relative. `make tauri` runs the native shell and Vite;
start `make backend` first. `make frontend` is browser-only development with
HTTP fallbacks, not a shipped browser client. Vite stays on port 5173.

## Layout and data boundaries

`renderer/src/` is one tree organised by feature. Keep feature screens, stores,
helpers and tests together: player, library, albums, playlists, browse,
acquisition, downloads, lyrics, stems, settings, onboarding, auth, pairing,
offline, analysis, uploads and viz. Shared controls live in `renderer/src/ui/`;
song/tag tools live in `renderer/src/library/tracks/`.

`renderer/src/shell/` owns App, the page table, routeStore and layout.
`renderer/src/state/` holds app-wide contexts and stores; `renderer/src/lib/`
holds shared non-UI helpers and ipc.ts. Backend calls use
`renderer/src/api/client.ts`, generated types in
`renderer/src/api/generated/schema.ts`, `renderer/src/data/http.ts` and query
hooks. Do not invent response interfaces to hide unknown responses: declare
the FastAPI response_model and regenerate. Native calls use
`renderer/src/bridge.ts`, never window.krobi directly.

Existing @ts-nocheck files are being typed in place. Removing a directive is
substantive work; add no new ones. `renderer/eslint-typing-pending.json` preserves
existing files awaiting stricter lint rules; remove entries as typing lands.
New modules receive the recommended TypeScript lint rules by default.
Keep aliases aligned across `renderer/tsconfig.json`, `renderer/vite.config.js`
and `renderer/vitest.config.ts`. Host code uses @state and @lib; @context and
@utils remain plugin compatibility aliases. Old paths contain only plugin forwarding files.
Test setup lives in `renderer/src/test/`.

`renderer/src/main.tsx` installs the native bridge before dynamically loading
`renderer/src/lib/apiAuth.ts`, then App/Gate. Auth interceptors install even when
booting without a credential. Read getApiToken per request; signing in can change
it and both windows need the event. Rust owns persisted credentials. Use
withMediaAccess for media; strip query credentials before parsing old url_path
values and replace stale query tokens.

Preserve context order in `renderer/src/shell/App.tsx`. Use singleton stores for work
that survives navigation (imports, downloads, lyrics, browse). Hash routing lives
in `renderer/src/shell/routeStore.ts`; browse overlays an entity stack.
Wait for an explicitly starting local nest; once shown, a reconnect must not
unmount the app. Remote mode adopts the server's root and guards local pickers.

## Identity and library keys

Only source === token denotes an account with personal rows; synthetic owner
privileges do not confer personal-library capability. Saving a server track
links it to the account. Playing does not implicitly save it. Device downloads are
local to this desktop, not remote-library rows. Prefer server relPath/mediaKey;
derive from path against the server root, not url_path or a display album name.
Keep the lyrics legacy fallback usable before identity/root fetches finish.

Ownership answers are positional; degraded means show no markers, and nearMatch
is a distinct state. Preserve provider/id for browse navigation. Server download
progress uses terminal and succeeded/failed, not completed alone.

## UI, dialogs and motion

Maintain Flipspin's kit in `renderer/src/ui/` alongside consumers; read
`renderer/src/ui/README.md` for token load order. Surface profiles stay scoped
to setup/settings islands; shared application motion/layer tokens have global
roles. Reuse CoverCard, PanelHeader and Menu, without nesting buttons.

Every modal is built on `renderer/src/ui/react/components/ModalLayer.tsx` and
its shared focus, dismissal and presence hooks. The settings modal uses those
hooks in place to retain scoped tokens. Render portals into the persistent layer
root; avoid making the whole app inert. Hold cleared dialog data with
`renderer/src/ui/react/useHeld.ts` so exit animation completes. Do not add
window Escape listeners or hand-made focus traps.

Use named duration/easing/layer tokens and `renderer/src/ui/react/motion.ts`
for JS motion, including reduced motion. Page changes use pageTransition.
Never show a bare "—" as a missing value: use Missing from
`renderer/src/ui/react/components/Missing.tsx` or missingWord for strings;
omit optional absent facts. Lower style baselines rather than broadening them.

## Translation and lyrics

English is the source key: t('Save'), not slugs. Never call t() at module
scope; static tables carry msg() keys and translate at render time. Stores call
i18n.t at invocation time. Use count for plurals and interpolate the app name.
Do not run `i18n:extract`; add each key by hand to both
`renderer/locales/es/translation.json` and `renderer/locales/en/translation.json`.
English values repeat the source copy (without context/plural suffixes); Spanish
values supply the translation. Existing copy tests still run in Spanish.

The release ships lyrics sync only, with no transcription. Timing correction
is an `[offset:]` tag (+ = sooner), written through
PUT /api/lyrics/{album}/{file}/offset. It is not a rewrite of every line timestamp.

## Player

`renderer/src/player/playerState.ts` is the pure transition table;
`renderer/src/player/PlaybackController.ts` owns intent, retries and resume
through the event-compatible engine port. Network retries reset the same source
at 1, 2, 4, 8 and 15 seconds, resume two seconds back, and pause the budget until
connected. Auth and decode retry once; navigation and pause cancel pending work.
HTTP status comes from the engine's fetch response.

`renderer/src/player/engine/` is the only audio-output owner. One persistent
Worker fetches audio in bounded Range slices and reuses format decoders.
One worklet splices trimmed PCM on its frame clock; never start the next song
with a timer. Decode the next head (at least ten seconds, or the whole shorter
track) during the current tail. Seek flushes obsolete PCM and rejects stale
completions by generation. Dispatch uses magic bytes, never the filename.
Unknown magic emits notSupported; there is no element fallback or WebCodecs path.

| Input | Decode / trim | Seek |
|---|---|---|
| MP3 | mpg123, LAME delay and padding | Xing TOC or CBR bitrate |
| FLAC | libFLAC WASM, STREAMINFO sample count | SEEKTABLE or frame-header bisection |
| Ogg Opus | libopus WASM, pre-skip and end granule | granule bisection with preroll |
| Ogg Vorbis | libvorbis WASM, end granule | granule bisection with overlap preroll |
| WAV | RIFF PCM 16/24/32-bit integer or float32, exact data frames | arithmetic |
| M4A / AAC / ALAC | AudioContext.decodeAudioData, native priming handling | decoded sample index |

The context keeps one rate. The worker resamples other rates with a streaming
64-tap windowed-sinc polyphase filter before the ring; history and phase span
chunks. Ogg end trimming belongs to the worker, avoiding the wrappers' relative
EOS counters after seeks; Opus pre-skip is applied once by its decoder.

M4A/AAC/ALAC is the one whole-file decode exception. One lease covers native
decoding and credit-driven chunking; an aborted OS decode retains the lease until
it settles. Only one native track is resident, capped at 600 MiB decoded PCM
(encoded input also has a 600 MiB cap). Release the AudioBuffer as soon as its
last chunk enters the ring, including on cancellation. Memory instrumentation
counts that buffer, encoded bytes, decoder pending PCM and transfer credit in
addition to ring bytes. The native-memory tests cover release and cancelled
decodes. Apple AAC and ALAC are expected to return exact frames; WebKit's known
ffmpeg AAC remainder (+344 frames at 44.1 kHz) is accepted and reported by the
matrix. Raw ADTS has no edit list; report its OS priming/padding without guessing.

The worklet rings hold at most two tracks and thirty seconds per track. Credit
includes transferable chunks in flight; decode credit reserves room for the next
chunk and a partly consumed chunk. Tests assert the byte budget and exact splice.
StemPlayer supplies four decoded stems and fader levels to that same worklet;
it owns no transport. Its separate 600 MB decode budget and next-song lookahead
remain. Original/stems switches retain the engine position and pause intent.

`renderer/src/stems/audioGraph.ts` owns the one AudioContext: engine output →
analyser → one levelling gain → volume → destination. ESLint's restricted syntax
and the boundary baseline ratchet prevent element playback and output connections
outside the engine and graph. The graph's tests may inspect destination.
`audioRef` remains a compatibility name in player, progress, lyrics and visualiser
APIs; its value is PlaybackPort, never an HTMLAudioElement. connectAudio observes
the existing analyser and creates no audio source.

Run the local recording driver with `node scripts/verify-player-engine.mjs`.
It generates a continuous tone split by sample for every format, records worklet
output in WebKit, and prints one JSON matrix with same-format and mixed-format
transitions, frame counts, quiet gaps, boundary clicks, startup/seek timing and
memory. Apple fixtures use afconvert; if its codecs are unavailable those rows
are explicitly skipped. ffmpeg's experimental Vorbis encoder needs its rounded
end granule corrected to the source sample count. An installed mpv supplies an
optional PCM reference; the driver never installs it. It is
not a CI benchmark. A sandbox that prevents WebKit launching cannot supply this
evidence; run the driver in an ordinary local terminal before release.

`KROBI_PLAYBACK_TRACE=1` includes test instrumentation and its overlay
(⌥⌘P) in development or packaged test builds. Release builds exclude it.
Promote trace code to the release only when it catches a playback defect or
answers a user report; record the reason here. No trace component is included.
The release keeps one warning per playback wait exceeding 500 ms (song key,
local/server source, position and wait time). This diagnoses reported offline
store mutex stalls at song start and during playback without enabling the
trace overlay or per-slice logging. Source comes from response cache headers;
before the first response, the diagnostic checks the scoped offline status.

## Compatibility during renderer cleanup

Settings code lives in `renderer/src/settings/`. Use English identifiers;
English sentences are translation keys. Resolve saved Spanish section ids
through `renderer/src/settings/sections.ts`. Preserve the emitted #/ajustes
hash; accept the English spelling as an alias.
Keep native/HTTP values, localStorage keys and stored drawer labels stable.
Plugin host imports use `renderer/src/plugins/host.ts` from lazy feature modules.
Deprecated context, page, data and test-helper paths remain through v0.2.
Plugin type aliases preserve external imports; `complemento`, `nido` and
`Extensión` remain plugin contract fields/values.

Pairing QR codes render SVG geometry with no credential in text attributes.
Preserve error correction Q, the 320 CSS pixel default and four-module quiet
zone. API adapters derive response types from the generated schema and narrow
unannotated bodies; delegate pairing semantics to its existing gateway.

## Testing

Run `npm run lint`, `npm run typecheck` and `npm test`; `make lint` includes
renderer checks alongside Python and Rust. Use Vitest's file filter for focused
iterations. UI changes also need `npm run build:frontend` and the visual driver
described in the UI README; check dialog dismissal, exit motion and keyboard focus.
Do not refresh style-baseline.json to accept an increase.

Refresh types offline with `npm run api:generate`. To capture a changed running
server, use `npm run api:generate -- --from http://127.0.0.1:8000 --save` and
review both schema and generated diffs. Keep optional plugin types/translations
plugin-owned and verify a clean host without linked extensions.

## What guards these rules

| Rule | Guard |
|---|---|
| Fixed renderer port | strictPort in `renderer/vite.config.js`; startup order not enforced yet |
| Generated responses and native bridge | TypeScript; `renderer/src/api/schema.test.ts`; `renderer/src/bridge.test.ts`; exclusive entry-point use not enforced yet |
| Typing debt, aliases and feature imports | ESLint; TypeScript; `renderer/src/api/noHandTypes.test.ts` |
| Credential changes and media access | `renderer/src/desktop/apiAuth.test.ts`; `renderer/src/desktop/mediaAccess.test.ts`; boot ordering requires review |
| Startup, reconnect and routing | `renderer/src/shell/Gate.test.tsx`; `renderer/src/shell/routeStore.test.ts`; provider ordering not enforced yet |
| Account scope and library keys | `renderer/src/auth/auth.test.tsx`; `renderer/src/library/libraryKeys.test.ts` consumes `contracts/library-keys.json` |
| Ownership and download outcomes | `renderer/src/browse/resolve.test.ts`; `renderer/src/downloads/AcquisitionRows.test.tsx` |
| Styles, motion and missing values | `renderer/src/ui/styleGuard.test.ts`; component choice and token scope not enforced yet in full |
| Modal focus, dismissal and exit | `renderer/src/ui/react/components/ModalLayer.test.tsx`; universal adoption not enforced yet |
| English source keys and translations | i18n lint/status; `renderer/src/i18nSource.test.ts`; module-scope translation ban not enforced yet |
| Lyrics offset semantics | `renderer/src/lyrics/lrc.test.ts` consumes `contracts/lyrics-offset.json` |
| Audio output ownership and release trace exclusion | ESLint; `renderer/src/api/noHandTypes.test.ts`; `renderer/src/player/trace.test.ts` |
| Settings compatibility and pairing | `renderer/src/settings/SettingsPage.navigation.test.tsx`; `renderer/src/plugins/host.test.tsx`; `renderer/src/pairing/QrCode.test.tsx` |
| Renderer validation and release packaging | ESLint, TypeScript, Vitest and Vite build; visual review and clean release packaging not enforced yet |
