# Lyrics alignment — plain words to synced LRC

When the words of a song are already known — a paste, Genius, LRCLIB's
`plainLyrics`, a `.txt` beside the song — Flipspin places *those* words on the
audio. The v1 Lyrics add-on provides forced alignment only; transcription
code and routes are retained for a later optional extra. No Whisper is installed
or fetched by the v1 flow. The output is a
line-level `.lrc`, per-word times, and a **confidence per line**, so a person
can see which lines to check.

The aligner is one standalone module, `helper/krobi_helper/kinds/lyrics/align.py`.
It needs `numpy`, `torch`, `torchaudio` and `ffmpeg`, and nothing else from
Flipspin, so another app can copy that file and call it.

## Installation and checkpoint integrity

Install the shared engine first, then Lyrics in Settings → Add-ons. The engine
installs Python and the ML runtime; Lyrics fetches only MMS and demucs. Stems
fetches demucs and beat_this, reusing the separator. Removing either add-on keeps
shared models needed by the other; both must be removed before the engine.
Catalog search (LRCLIB and Genius) needs no add-on.

The downloader in `helper/krobi_helper/kinds/lyrics/align.py` holds both URLs
and the expected SHA-256 in one place. It tries torchaudio's primary host, then
[a revision-pinned Hugging Face mirror](https://huggingface.co/selectorrrr/ctc_alignment_mling_uroman/tree/c13912af40f24d0f910181f141d6f917caf6edcc).
The mirror's LFS object hash matches the original cached checkpoint:
`20ef12963ab4924bef49ac4fc7f58ad5da2ee43b2c11bc8c853c9b90ecdbc680`.
Every download is checked before atomic publication and before loading;
a mismatch leaves Repair available and never loads the file. TLS verification
is always enabled. Raw failures are in the helper log and UI tooltip.

## Use it

### Command line (the Mac engine)

```
krobi-helper align --audio song.mp3 --text lyrics.txt --out song.lrc
    [--vocals vocals.ogg]   # a vocals stem of the same song: skips demucs
    [--no-isolate]          # align on the mix (faster, less accurate)
    [--words words.json]    # default <out>.words.json
    [--word-tags]           # enhanced LRC <mm:ss.xx> word stamps
    [--language es|en]      # only used to spell digits; guessed otherwise
    [--device mps|cpu]      # default: best available
    [--wildcard stanza|line|edges|none] [--threshold 0.15] [--lead 0]
    [--json]                # protocol JSON lines on stdout (see protocol.py)
```

Without `--json` it prints a one-line summary and the lines below the threshold
on stderr. With `--json`, the last line is
`{"event":"done", "lrc", "words", "lines", "lineConfidence":[…], "lowLines":[…], "device", "seconds", "leadSeconds"}`.

### Python

```python
from krobi_helper.align import align_file, to_lrc
result = align_file("vocals.wav", plain_text)        # anything ffmpeg reads
open("song.lrc", "w").write(to_lrc(result.lines))
result.low_lines                    # indexes of the lines to review
result.lines[0].conf, result.lines[0].words   # 0–1, and per-word times
```

### Server

`POST /api/lyrics/transcribe {tracks: [{album, file, text?}]}`, unchanged.
When a text is known the job **aligns**: the text in the body, or the plain
lyric already on disk. A hand-written plain lyric (`edited`) can be aligned too.
The result keeps every word as typed and stays marked as edited. An edited
*synced* lyric is never touched. When the song has a fresh split
(`docs/stems.md`: same file size and mtime), its vocals stem is used instead
of running demucs again, both locally and through the agent (`vocalsPath` in
the claim).

The stored lyric gains two **additive** fields on `GET /api/lyrics/{album}/{file}`:

| field | meaning |
|---|---|
| `lineConfidence` | one 0–1 score per LRC line, in file order (the mean CTC posterior of its characters) |
| `lowLines` | indexes of the lines below the threshold (0.15) |

Both are `null` for anything that was not aligned. Any later save clears them:
a refetch, a hand edit, a sync nudge. The agent posts them on
`POST /api/helpers/jobs/{id}/result` as JSON alongside `lease`, `ok`, `lrc`
and `source`. Worker 0.10.0 falls back on 404 to `/api/lyrics/agent/result`
(also additive; an older server ignores the confidence fields). The old agent
routes keep their exact wire shapes until `MIN_WORKER_VERSION` exceeds 0.10.0.
See the [agent protocol](../helper/README.md#agent-protocol-0100).

### Desktop

A song with a plain lyric shows **"Sync"** in the lyrics view. It shows
the engine's phase while it runs, then the view reloads synced. Without a ready
engine it opens "Lyrics…", where the engine is installed. Low-confidence lines
get a dotted, yellow stamp, with "Timing uncertain" as the tooltip.

The `.lrc` sidecar stays line-level. Flipspin Móvil's parser does not strip
enhanced `<mm:ss.xx>` word tags, so word times stay in `words.json` (CLI) and
`--word-tags` is opt-in.

## How it works, and why each step

1. **Text.** Lines are romanized for the aligner only, because the MMS
   dictionary is bare `a–z'`: NFKD, diacritics stripped, digits spelled out
   (es/en, "12" → "doce"). The output keeps the original spelling. Section
   labels ("[Coro]", "Verse 2:", "(x2)") are dropped; blank lines mark stanzas.
2. **Emissions in 8 s windows** with 3 s of context on each side, on MPS.
   - The old path ran one pass over the whole song on the CPU: 40–130 s and
     4–6 GB.
   - Short windows are also *more accurate*. wav2vec2 was trained on
     utterances, not minutes: lines within 1 s went 72 % at 30 s windows →
     84 % at 15 s → 90.5 % at 8 s.
   - Window bounds are whole frame hops, so frames don't drift from one window
     to the next.
3. **A `<star>` wildcard** (MMS_FA `with_star`) at every stanza break and at
   both ends.
   - It absorbs singing the text lacks and text the audio lacks, instead of
     stretching the neighbours.
   - It stays free (log-prob 0). Any penalty pins it to one frame, and that
     measured worse — on one song, catastrophically.
4. **CTC Viterbi** (`align.viterbi`, numpy, ~0.3 s per song).
   `torchaudio.functional.forced_align` (torchaudio 2.11 / torch 2.14) returned
   non-optimal paths on ties: a case scoring −21 where −1 exists, a letter put
   49 frames late. That API is also on torchaudio's way out. A brute-force test
   pins the optimum.
5. **Strays.** A character parked more than 1 s before the rest of its word
   (a lone "l" 8 s before "ittle") does not set the word's time.
6. **Confidence.** A line below 0.15 is flagged, never dropped.
7. **No offset is applied.** Times are where the voice starts. `--lead` exists
   for a caller that wants hand-made LRC's convention, and is reported in
   `leadSeconds`.

## Measured

M1 Pro, 16 GB. Six songs from the library, each scored against LRCLIB
`syncedLyrics`, with LRCLIB `plainLyrics` (stanza breaks kept) as the input
text.

⚠ **LRCLIB's stamps lead the voice.** On the songs here the lead is 0–0.6 s,
confirmed on the vocal stem's energy, and every method sees the same constant.
So the columns below are **after removing each run's median offset**: they
measure the aligner, not the LRC author's habit. The offset is shown so nothing
is hidden.

| Song | Length | Lines | Before: whole song, CPU (≤1 s · ≤300 ms · time) | 30 s windows | **Now** (≤1 s · ≤300 ms · emissions) | Now, on the mix | Flags: caught/bad (flagged) | LRCLIB lead |
|---|---|---|---|---|---|---|---|---|
| Bad Bunny – PIToRRO DE COCO | 3:56 | 45 | 80 % · 78 % · 62 s | 93 % | **100 %** · 98 % · 13 s | 96 % | 0/0 (2) | +0.58 s |
| Tame Impala – New Person, Same Old Mistakes | 6:04 | 52 | 71 % · 62 % · 111 s | 60 % | **85 %** · 67 % · 17 s | 69 % | 7/8 (30) | +0.52 s |
| Bad Bunny – BAILE INoLVIDABLE | 6:18 | 68 | 49 % · 40 % · 132 s | 53 % | **85 %** · 71 % · 17 s | 84 % | 9/10 (21) | +0.06 s |
| The Beatles – Here Comes The Sun | 3:06 | 27 | 70 % · 63 % · 39 s | 56 % | **93 %** · 74 % · 9 s | 67 % | 2/2 (10) | +0.27 s |
| Caifanes – La Negra Tomasa | 3:25 | 24 | 96 % · 88 % · 40 s | 92 % | **100 %** · 92 % · 10 s | 100 % | 0/0 (1) | −0.01 s |
| Drake ft. Travis Scott – Fair Trade | 4:51 | 107 | 66 % · 59 % · 76 s | 75 % | **80 %** · 72 % · 13 s | 80 % | 21/21 (26) | +0.10 s |
| **Mean** | | 323 | **72 % · 65 %** · 460 s total | 72 % | **90.5 % · 79 %** · 80 s total | 83 % | **39/41** (90) | |

How to read it:

- **Before** is the code as it shipped at the start of this change, run
  unmodified on the same vocal stems.
- **Time:** "before" is the whole alignment. "Now" is the MPS emissions,
  including the model load. The Viterbi adds ~0.3 s per song.
- **Flags:** at 0.15 the flag catches 39 of the 41 lines more than 1 s off.
  About half of what it flags is fine, which is right for a "revisar" marker
  and wrong for deleting lines.
- **Vocals beat the mix** (90.5 % against 83 %), so demucs stays the default.

End to end, `krobi-helper align` on the 3:25 Caifanes song, cold process:

| Path | Wall | Peak memory |
|---|---|---|
| With demucs | 23.5 s | 10.6 GB (demucs) |
| With an existing vocals stem | 11.3 s | 3.1 GB |
| On the mix | 10.7 s | 3.1 GB |

## What it does not fix

- **Overlapping voices.** A backing line sung *over* the lead, often written in
  parentheses, cannot be placed by a single path. Tame Impala's outro is the
  case; its lines are flagged.
- **Layered, chant-like repeats** ("Sun, sun, sun, here it comes" ×5) can be
  squeezed together. They come out flagged.
- **Text that is not sung.** "doo-doo-doo" written for a guitar riff gets
  placed somewhere and flagged.
- **Unwritten repeats** ("x2" shorthand, a chorus written once). Labels are
  dropped, but a repeat that is not in the text is absorbed by a stanza
  wildcard at best.

## Licences

- MMS_FA weights: **CC-BY-NC 4.0** — personal use. The engine downloads them
  on the user's Mac and never bundles them. A commercially clean alternative
  would be the NeMo Forced Aligner with a Parakeet model, a much bigger
  install.
- The rest (the module, the Viterbi) is Flipspin's own code.

## Options considered (2026-10-15 scoping)

- **Whisper alignment without generation.** Teacher-forced decoding plus
  cross-attention DTW (stable-ts style) on mlx-whisper ran in 3–7 s, but a
  quick version put only 22 % of lines within 300 ms. It collapsed on a 41 s
  instrumental intro.
- **An MLX port of the CTC model.** Not worth it while emissions take ~3 s per
  minute on MPS.
- **Coarse-to-fine** (Whisper anchors + CTC inside them). Kept as a fallback
  idea for texts that disagree a lot with the audio. It brings generation back.

## Desktop packaging

Every Tauri release build runs `npm run build:desktop`, which builds the lyrics
worker wheel before compiling the frontend. `scripts/build-helper.cjs`
stages the freshly built helper and one-release compatibility wheels, and
fails the build if either cannot be produced. This is independent of PyInstaller: updating the desktop UI must not
retain an older worker that lacks alignment. The alignment UI requires worker
0.5.0 or newer. Updating the app supplies that wheel; **Update engine** installs
it into the Mac's engine environment and restarts the agent.

Plain `.txt` imports and pasted lyrics enter the same preview flow, with
**Sync to song** in the fixed footer. `.lrc` files with timestamps can be used
directly. Imported text is marked as edited so automatic acquisition cannot
overwrite it.

Worker names, availability, job progress and Sync/Resync controls live in the
lyrics acquisition modal. The main lyrics screen opens it through **Change
lyrics**. When the chosen words match the saved timed lyrics, the modal shows
**Already synced** and resyncs those words without saving the plain draft over
the timed version. Each catalog result explicitly labels its source.

Songs without lyrics also offer **Find lyrics** beneath the empty-state text.
Catalog failures display the provider's error instead of an empty result. A
rate-limit response includes the remaining shared cooldown as `retryAfter`
and a `Retry-After` header; the modal counts down and disables **Search again**
until it expires, without automatically retrying. Source settings links close
both lyrics surfaces before opening **Settings → Sources**.

The nest owner can save, replace or remove a Genius access token in
**Settings → Sources → Genius → Connection**. A successful save takes effect
immediately; the UI reports whether a key is configured, without returning the
key or claiming Genius has validated it. Other household members can see the
configured status but cannot change the credential. The form never stores the
key in renderer storage and clears its password field after a successful save.

The server writes `credentials/genius.json` atomically with owner-only file
permissions. This saved setting overrides `KROBI_GENIUS_API_KEY` (which remains
the fallback when no saved setting exists). Removing a key persists an empty
override so an environment key does not unexpectedly reappear after restart.
GET `/api/config/genius` returns only `configured` and `canManage`; owner-only
PUT accepts `apiKey`, and DELETE removes the configured key. The app shows an
upgrade hint if connected to an older server without these endpoints.

## Local lyrics and timing adjustments

**Settings → Lyrics → Keep lyrics on this device** enables an IndexedDB cache
for lyrics as they are opened; it does not download the whole library. The
cache is scoped to the server and account. Edits commit locally before showing
success, then a persistent per-song queue coalesces changes and uploads them
in the background. Network failures retry, including after restarting the app.
Pending edits survive server refreshes. Turning the option off is blocked until
pending changes are synchronized or explicitly discarded.

The timing view keeps lyric row DOM nodes stable and subscribes to the playback
clock separately from the list. Frame polling stops while paused or covered by
the visualizer. With local storage disabled, timing saves are serialized and
debounced; with it enabled, they commit locally immediately and debounce the
background upload.

GET and PUT lyric responses include a `revision` of the persisted document.
PUT accepts `expectedRevision`: an empty string requires no existing lyric,
while an omitted/null value retains legacy behavior. A mismatch returns 409,
even with `force: true`. The service serializes checks and writes across its
threads; this is not a lock across multiple backend processes or external file
editors. PUT returns the persisted text, including normalized trailing newlines,
so its revision agrees with the next GET.

Conflicts remain local until the user chooses a version in Settings. Resolution
waits for an in-flight upload, and sync checks the queue again after its server
read to avoid uploading a discarded or superseded edit. Servers without revision
support block queued uploads until upgraded. Alignment waits for the selected
song's local edits to synchronize. These checks protect edits; they do not merge
different versions of the lyrics automatically.
 
Genius searches the full tagged title first. If it returns no hits for a title
ending in `(Album Version)` or `[Album Version]`, it retries without that release
label. Live, remix, and acoustic qualifiers remain intact. This handles titles
such as Nsqk's “No Basta Con Querernos Más (Album Version)” whose Genius page
uses the base title, without changing the song's saved metadata or lyrics.
Genius extraction removes elements marked `data-exclude-from-selection="true"`
inside lyric containers (credits, title and song biography), plus embedded UI
buttons and scripts. Lyric annotation links, section labels and line breaks stay.

When a search result or supplied draft is selected, the acquisition dialog hides the saved-lyrics resync action. The footer names the selected source and explains replacement; its sync action saves that preview before passing those same words to alignment. The saved-lyrics action is available only when search has no selected replacement.

## CPU/CUDA engine evidence

Historical commands and artifact names below predate the helper rename. Current installs
use `helper/`, `krobi_helper`, `krobi-helper` and `tools/helper/venv`.

Worker **0.8.0** adds portable PyTorch htdemucs and **OpenAI Whisper
large-v3-turbo**; Apple Silicon still uses the existing MLX implementations,
model and transcription options. The shared hallucination filter still rejects
`no_speech_prob > 0.6`, `avg_logprob < -1.0`, stock phrases and short repeated
loops. MMS alignment and beat tracking use the selected torch device (`mps`
for MLX machines, otherwise `cuda` or `cpu`). `KROBI_ACCEL=cpu`, or the hidden
`--accel cpu` on a command, forces every stage and agent child to CPU.

`acceleration.py` owns machine facts, selection and installed job capabilities.
Runtime CUDA selection uses `torch.cuda.is_available()` and the GPU name.
`check` reads `find_spec`/torch build metadata and queries libcudart's device
count/name directly, avoiding a torch/MLX import. This lightweight CUDA probe
has unit coverage but has not been exercised on NVIDIA hardware. `jobs` is
conservative: installed audio dependencies and separator plus each job's own
libraries; models can be fetched on first use. Missing checkpoints still make
`ready` false. The agent sends `os`, `accel`, `gpu`, `chip`, `memoryBytes` and
`jobs` on both claims and heartbeats. The backend minimum is **0.8.0**, the
first worker that sends acceleration, as required by the helper contract.

The backend install gate now accepts macOS arm64, Linux x86_64/arm64 and
Windows x86_64. Other targets retain `unsupported-platform`. The
`engine_mode` decision code is unchanged. Platform dependency markers keep
MLX off PCs; `.[portable]` adds the portable libraries on an Apple Silicon
measurement host. Linux/Windows x86_64 installs use uv's
[`--torch-backend auto`](https://docs.astral.sh/uv/guides/integration/pytorch/)
to select compatible GPU wheels or CPU wheels. Linux arm64 uses published
PyPI wheels. Windows also has executable/venv paths, agent locking, parent
watching, signals and process-tree cancellation handled without POSIX-only APIs.
Worker **0.9.0** stages the pure Python wheel on every desktop build, using
`resources/backend/bin/uv.exe` on Windows and `bin/uv` on macOS/Linux when
bundled (otherwise PATH uv). The shared Tauri `resources/backend/` mapping
includes `lyrics-worker/` in each platform's installer. The agent now reports
per-job `keepAwake` via the shell hand-off; older shells retain caffeinate.

### Transcription library decision

Both [OpenAI Whisper](https://github.com/openai/whisper) and
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) are MIT-licensed,
compatible with this AGPL-3.0-or-later program. Faster-whisper is the faster CPU
option: its published small-model benchmark is 1m42s/int8 versus
6m58s/OpenAI fp32 (13 minutes of speech, Intel i7-12700K; **not** this song or
the turbo model). OpenAI Whisper was chosen to share the existing PyTorch
runtime with Demucs/MMS, retain the original large-v3-turbo checkpoint and
options, and avoid CTranslate2/PyAV/ONNX Runtime plus a separate CUDA/cuDNN
compatibility matrix. OpenAI still needs its Python/tokenizer/Numba dependencies
and a separate `.pt` checkpoint; this is an installation tradeoff, not a measured
claim that it uses less disk. Full CPU/CUDA install sizes: **—**. The sandbox
could not resolve PyPI, so a fresh portable installation was not measured.

### CPU measurements on M1 Pro

A 190-second excerpt with reference lyrics and four fresh CPU stems exercises
stems reuse during alignment. Runs use four CPU threads, Python 3.12.13,
torch 2.14.1, torchaudio 2.11.0, and Demucs 4.1.0. Background tests were running,
so these observations are not isolated hardware benchmarks.

| Job | Wall seconds | Peak RSS | Result |
|---|---:|---:|---|
| Align with fresh vocals | 30.21 | 2.53 GiB | 54 LRC lines; four low-confidence lines |
| Stems | 135.36 | 1.95 GiB | Four stereo Opus stems and a manifest |
| Capability probe | 0.17 | 28 MiB | Available jobs reflect installed models |

Wall time includes interpreter startup. Peak RSS comes from the measured child
process's macOS resource usage; it does not measure total unified GPU memory.
Alignment spends 0.74 seconds decoding, 27.38 generating emissions, and 0.29 on
CTC. ffprobe verifies four stereo Opus stems lasting 190.0065 seconds.

### CPU transcription

With OpenAI Whisper large-v3-turbo on M1 Pro, a 190-second French song without
vocal isolation takes 140.6 seconds including the first 1.51 GB model download,
with 3.94 GB peak RSS and 20 synced lines. A warm run takes 86.89 seconds and
produces the same line count. Warm peak RSS is unavailable because the timing
wrapper cannot complete resource accounting in the sandbox.

Use an isolated model/cache directory, force KROBI_ACCEL=cpu, and record cold
and warm runs separately. CUDA, native Windows inference, and fresh portable
installation sizes require separate measurements; CPU results do not establish
their quality or resource use.
