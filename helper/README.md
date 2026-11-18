# krobi-helper

The helper runs on Apple Silicon (`mlx`), NVIDIA PCs (`cuda`), and plain
PCs (`cpu`). macOS needs a native install for Metal. Supported install targets:
macOS arm64, Linux x86_64/arm64, Windows x86_64. The backend's engine placement
setting is unchanged.

It is a separate Python program on purpose: `torch`, `demucs-mlx` and the
MMS forced aligner weigh gigabytes and would not fit the PyInstaller backend.
The backend installs it on demand into `~/Krobi/tools/helper/venv` from the
wheel bundled beside it (`resources/backend/helper-worker/`), or from this
directory in development, and talks to it over one subprocess per batch with
JSON lines on stdout (see `protocol.py`).

Installation requires `uv` (`brew install uv` on a Mac) and uses its managed
CPython. An existing venv backed by another Python is reported as broken:
reinstall the engine with uv. Homebrew's `Python.app` has a separate macOS
Local Network identity and can block the agent's requests to a remote nest.

The base package needs only numpy. `.[engine]` installs the existing lyrics
and stems runtime; `.[analysis]` installs CPU onnxruntime and krobi-keyfinder
without torch. Install the union of extras for the selected add-ons.

The engine uses CPU torch wheels on every platform (`--torch-backend cpu`).
Apple Silicon includes MLX with Lyrics and Stems. NVIDIA acceleration is an
explicit, separate torch swap: CUDA 13, driver 580+, Turing or newer. AMD/Intel
GPU packs are not offered in v1. Install/remove it in Add-ons → GPU acceleration,
or through the existing `gpu` install target. Removing swaps torch back to CPU.

`krobi-helper gpu --uv UV_PATH` installs the pinned CUDA torch layer;
`--remove` restores CPU torch. No ONNX model has GPU approval: Analysis uses
CPUExecutionProvider even when a GPU pack is installed, and pack changes remove
onnxruntime-gpu before repairing CPU onnxruntime. Never install both builds.

`check` never imports torch or MLX. It reports the installed add-ons and a GPU
row with card, driver, eligibility, estimated download size and pack version.
`models/addons.json` retains model choices and a `packs` record. Legacy CUDA
and MLX installs are adopted without downloading or replacing their packages.
Jobs return `accel` (`mlx`, `cuda`, `cpu`), plus `fallbackReason` (`oom`, `driver`)
when an accelerator fails and the job is retried once on CPU. Lyrics results and
stems manifests retain that evidence. Unknown models default to CPU; new model
accelerators require a parity check before joining the policy in execution.py.

For diagnostics/benchmarks on a Mac, install the optional `.[portable]` extra
and set `KROBI_ACCEL=cpu` (or pass the hidden `--accel cpu` after any command).
The override reaches separation, transcription, alignment, beats and agent job
children. Store models in `KROBI_MODELS_DIR`, `HF_HOME` and `TORCH_HOME`; portable
Whisper checkpoints live beside the torch cache in `whisper/`.

Commands:

    krobi-helper check --json       # what is installed, which models are present
    krobi-helper prefetch --addon lyrics --json # MMS aligner + shared demucs
    krobi-helper prefetch --addon stems --json  # shared demucs + beat_this
    krobi-helper prefetch --addon analysis --json # verified TempoCNN ONNX + AGPL notice
    krobi-helper analysis --jobs jobs.json --out-dir DIR # key/tempo/mood inputs, up to 25
    krobi-helper remove --addon lyrics         # keeps demucs if Stems still needs it
    krobi-helper run --jobs jobs.json --out-dir DIR   # process a batch
    krobi-helper align --audio X --text Y --out Z.lrc # known words → synced LRC, no Whisper
    krobi-helper stems --job job.json --out-dir DIR   # split one song: 4 Opus stems + song.json
    krobi-helper agent --server URL                   # drain a server's lyrics, stems + plugin queues

`stems` (`krobi_helper/kinds/stems/pipeline.py`): ffmpeg → beat_this (beats/downbeats) →
htdemucs via MLX (`batch_size=1`, 5.6 GB peak) → 16 chops per stem snapped to
zero crossings → Opus 192k → `song.json`. About 13 s for a 3-minute song on an
M1 Pro once warm. The server implementation and contract: `backend/app/domains/stems/`.

The v1 Lyrics add-on synchronizes known words with MMS forced alignment;
transcription code and routes remain dormant. Whisper is an optional
`.[transcription]` extra and is never prefetched or installed by the v1 flow.
Alignment takes ~10–17 s per song on an M-series Mac, with per-line confidence.
See `docs/lyrics-align.md` for the algorithm and limitations.

One venv serves three independently selected add-ons. Lyrics and Stems need
the engine first; Analysis installs alone. The engine downloads packages only.
Removing the shared venv requires all add-ons removed first. `models/addons.json` records model ownership, including
incomplete installs so Repair and Remove remain available. Legacy caches are
adopted once; removing an add-on never re-enables it from shared files.
Each add-on's measured footprint includes demucs; shared bytes are not an
additional download. Before install the UI shows estimates (engine 1.3 GB,
Lyrics 1.4 GB, Stems 0.3 GB). Models and completed song results are separate.

The MMS source URLs, pinned mirror revision and SHA-256 live together in the
standalone `krobi_helper/kinds/lyrics/align.py`. Downloads use verified TLS,
fall back from torchaudio's host to Hugging Face, verify the checkpoint hash,
and atomically publish only matching files. The checkpoint remains CC-BY-NC 4.0.
Raw install errors go to `~/Krobi/logs/helper-install.log`; the UI shows a
localized short message with raw detail in its tooltip. Repair retries the
same engine or add-on operation.

## Agent protocol (0.10.0)

A helper uses its own owner-enrolled helper device token and dials out through
`/api/helpers/*`: `POST /claim` offers `kinds` (`align`, `transcribe`, `stems`, `analysis`),
hardware `capabilities`, `workerId`, `sessionId`, `name` and `version`. The server
returns **204** or `{job: {id, kind, input}, lease}`, choosing lyrics first and
then stems, then analysis, with one active lease per device across all kinds.

For either kind, `POST /jobs/{id}/heartbeat {lease, phase?, progress?, agent?}`
returns `{stop, reason?}`. Stop discards the work. `POST /jobs/{id}/result` uses
JSON for lyrics (`lease`, `ok`, `lrc`, `source`, `error`, `final`, optional
`lineConfidence`/`lowLines`) and multipart for stems (`lease`, `song.json`, four
stem uploads, or `ok=false`, `error`, `final`). Stems upload caps stay 4 MB for
the manifest and 128 MB per stem, with **413** naming the part. Goodbye is
`POST /bye {reason: "quit" | "sleep", sessionId}`. All paths here are relative
to `/api/helpers`.

On **404**, the agent uses `/api/lyrics/agent/*` and `/api/stems/agent/*`,
retaining lyrics-first polling on an older server. Authentication/server errors
do not trigger fallback. Old installed helpers keep the exact legacy wire
shapes through aliases; retain those until `MIN_WORKER_VERSION` exceeds
**0.10.0**. The shared lease queue still expires after 600 seconds, allows three
attempts, ignores stale results, and keeps receipts for accepted retries.
See [`docs/stems.md`](../docs/stems.md#worker-side-the-helpers) for the full
wire contract, and `contracts/helper-protocol.json` for executable cases.

## Worker plugins

Install optional packages exposing `register(registry)` through the
`krobi_helper.plugins` entry-point group. The registry supports commands,
status checks and claim steps after lyrics and stems. The v1 add-on installer
does not invoke plugin prefetch hooks.
Registration and checks must avoid importing ML libraries. A claim step takes
an `Agent` and returns true when it processed work; the first such step ends
that turn. Plugins may use the agent's generic batch subprocess runner.

Installers accept all bundled wheels together. For development, set
`KROBI_LYRICS_PLUGIN_SOURCES` to source paths separated by the OS path separator.

## Rename compatibility (0.11.0)

`krobi-helper` is the command; `krobi-lyrics` remains an alias for one release.
The `[lyrics]` and `[stems]` extras describe each kind's dependencies; both are
also installed by default while the app provisions a single engine.

On launch or install, an existing `tools/lyrics` tree is reused through a
`tools/helper` directory symlink (Windows: junction). Keeping the original
venv in place preserves its absolute launchers, installed packages, live lock,
worker identity and status. Models remain under `~/Krobi/models`; migration
runs no prefetch. A newer bundled wheel replaces only the packages.
Logs use `~/Krobi/logs/helper-agent.log`; the old `lyrics-agent.log` remains
readable (a shared file through a symlink on Unix or a hard link on Windows).

Set `KROBI_HELPER_SRC` to override the package source. The former
`KROBI_LYRICS_WORKER_SRC` remains a fallback. Development installers include
`compat/`, a one-release `krobi-lyrics` distribution and `krobi_lyrics` import
bridge for existing plugins. Both wheels ship in `backend/helper-worker/`.
Plugins in `krobi_lyrics.plugins` and plugin wheels staged in the former
`backend/lyrics-worker/` directory are still loaded for one release. If a plugin
registers the same name in both groups, the new group takes precedence.

Analysis uses whole-track libKeyFinder and TempoCNN ONNX on CPU, in one child
per batch. The result contract, formulas, checksum and release prerequisites
are in [docs/analysis.md](../docs/analysis.md). KeyFinder/FFTW are statically
linked into platform wheels built from `keyfinder/`; CI builds and tests macOS
arm64, Linux x86_64/aarch64 and Windows x86_64.
