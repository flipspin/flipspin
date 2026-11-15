# Clean-install QA and the server image

Run from the repository root as your normal (non-root) account:

```sh
make qa-install
make qa-install QA_PLATFORM=linux/amd64
make qa-install QA_PLATFORM=linux/arm64
```

Requires Docker and Python 3's standard library; no development venv is needed.
The runner always builds the working tree with `backend/Dockerfile`, loads the
local `krobi:qa` tag, and uses fresh, empty bind mounts. It never pushes. Docker
allocates a loopback host port. Every invocation has its own container and temp
folders; do not build different architectures into `krobi:qa` concurrently.
`QA_BUILDER=name` optionally selects an existing buildx builder.

The nine PASS/FAIL lines cover the build; API and Docker health within 90 seconds;
unclaimed status; strict first claim and setup-token deletion; a tagged five-second
`Test Artist/Test Album/01 Canción.mp3`, listing, full playback and Range; restart
persistence; the uvicorn UID, host `users.json` mode and writable-layer changes;
logs; and cleanup. Later dependent checks report FAIL if an earlier check blocked
them. Logs are checked even after an earlier failure. Any failure exits nonzero.
Cleanup runs on failure, Ctrl-C and SIGTERM. The built local image is retained.

The write check uses `docker diff` over the whole writable layer, including
removals. Only `/data`, `/music`, and the entrypoint's explicit account-remapping
files under `/etc` (passwd/group/shadow/gshadow/subuid/subgid, backups and lock)
are allowed. It does not exempt `/tmp`, `/root`, code or site-packages. Account
files must change when PUID/PGID differ from the image defaults.

CI's `qa-install` job runs on Ubuntu amd64 with a ten-minute timeout. The
build-push action loads locally and saves buildx layers to the GHA cache; the
script's required build uses that same builder and reuses those layers. No
registry login or image push is involved.

The clean-install checks also require one English setup block in the log before
claiming, a 0600 setup-token file, and no setup code in `/api/status`. A restart
after claiming must add no setup block. Both the tagged nested song and an
untagged root-level `Loose Song.mp3` must stream with Range and keep their keys
after restart. The root album displays as **Loose songs**.

## FFmpeg selection

The Dockerfile compiles FFmpeg **8.1.3** from
<https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz>, verified against SHA-256
`7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3`.
The same source/configuration builds for linux/amd64 and linux/arm64. Debian
trixie supplies LAME, Opus, Vorbis/Ogg, OpenSSL 3 and zlib; build tools and headers
stay in a separate stage. FFmpeg libraries are linked into ffmpeg/ffprobe;
those external libraries remain dynamically linked.

The alternatives considered were a pinned prebuilt static bundle and Debian's
ffmpeg package. Static bundles usually retain broad video support and introduce
a separate binary supplier and architecture-specific artifacts. Debian's package
already used `--no-install-recommends`; its hard library dependencies still
bring the video/GPU stack. Compiling selected components avoids both issues,
with a short, cacheable native build. Selection follows FFmpeg's
[codec configuration documentation](https://ffmpeg.org/ffmpeg-codecs.html).

`backend/ffmpeg-build.sh` records the exact configuration. It retains MP3,
AAC/M4A, Opus/OGG/WebM, Vorbis, FLAC, WAV/PCM, other common audio decoders,
HTTP(S)/HLS and the PCM pipes/resampling used for analysis and helper audio.
`loudnorm` and `volume` preserve download normalization. JPEG/PNG/WebP and other
still-image decoders, `scale`, and the MJPEG/PNG encoders preserve covers;
there are no other video encoders. `lavfi`/`sine` support the QA fixture.
BPM/key analysis dependencies, including scipy, numba, llvmlite and scikit-learn,
are retained, including their installed package test directories.

The build enables GPL and version 3, with **no nonfree components**. It probes
both executables with `-version` and `-L` and refuses `--enable-nonfree`,
“nonfree parts compiled in”, or “not legally redistributable”, matching the
desktop packager. The image retains GPLv3 text, FFmpeg's licensing notice,
configuration and the source URL/hash at `/usr/local/share/krobi-ffmpeg/`.
Any future redistribution must preserve the project's GPL corresponding-source
obligations for FFmpeg and its linked libraries; Debian package versions and
copyright notices identify the external library sources.

The resolver is unchanged: `KROBI_FFMPEG_PATH`, then system PATH, then the
bundled fallback. In the image it selects `/usr/local/bin/ffmpeg` as `system`;
ffprobe is adjacent for yt-dlp. `requirements-server.txt` contains shared pins;
`requirements-runtime.txt` includes them and adds imageio-ffmpeg for standalone
installs. Desktop `requirements.txt` keeps its imageio pin. Docker installs only
the shared pins and uninstalls pip/setuptools/wheel from the final venv. Pin tests
follow requirements includes and assert the container set excludes only imageio.

## Local evidence

Sizes below use Docker Desktop's local-storage accounting (`docker system df -v`),
the same view that reports the original arm64 image as 1.59 GB. Containerd's
`docker image inspect .Size` reports compressed content separately on this host;
it must not be compared directly with that 1.59 GB figure.

| Architecture | Existing baseline tag | Before | After | Compressed content before → after |
| --- | --- | ---: | ---: | ---: |
| arm64 (native) | `krobi:alpha-test` | 1.59 GB | 927 MB | 401,627,442 → 214,067,723 bytes |
| amd64 (local Rosetta emulation) | `krobi:alpha-amd64` | 1.66 GB | 926 MB | 416,352,084 → 220,022,283 bytes |

The local-storage reductions are approximately 42% and 44%, respectively.
Sizes were read after the images had been unpacked by running containers.
A newly loaded containerd image can show only its compressed size until first run.

Both architectures report:

```text
ffmpeg version 8.1.3 Copyright (c) 2000-2026 the FFmpeg developers
ffprobe version 8.1.3 Copyright (c) 2007-2026 the FFmpeg developers
```

Selected `ffmpeg -hide_banner -codecs` output (`D` = decode, `E` = encode):

```text
 DEA.L. aac                  AAC (Advanced Audio Coding) (decoders: aac aac_fixed)
 DEAI.S flac                 FLAC (Free Lossless Audio Codec)
 DEAIL. mp3                  MP3 (MPEG audio layer 3) (decoders: mp3float mp3) (encoders: libmp3lame)
 DEAIL. opus                 Opus (Opus Interactive Audio Codec) (encoders: libopus)
 DEAI.S pcm_s16le            PCM signed 16-bit little-endian
 DEAIL. vorbis               Vorbis (encoders: libvorbis)
```

On each architecture, additional local checks actually encoded and decoded
MP3, AAC, M4A, Opus, OGG/Vorbis, WebM/Opus, FLAC and WAV, inspected them with
ffprobe, and resampled them to mono 16 kHz float PCM. `loudnorm,volume` produced
MP3 successfully. Real JPEG, PNG and WebP fixtures passed the application's
`CoverCache._resize` to scaled MJPEG/yuvj444p. The only listed video encoders
are MJPEG and PNG. Both executables passed the GPL/nonfree check, the resolver
reported `system`, and imageio/pip/setuptools/wheel were absent from the venv.

A container-side librosa check on arm64 computed tempo 123.05 BPM from synthetic
onsets and a `(12, 87)` chromagram, with numba 0.61.2, scipy 1.15.3 and scikit-learn
1.7.0. The focused repository tests (dependency pins, ffmpeg resolution, audio
decode, cover cache and cover thumbnail routes) passed **51/51**. Ruff, shell
syntax, workflow YAML parsing and `git diff --check` also passed. The hosted
GitHub Actions job has not been run from this worktree.

Final clean-install runs (both exited 0):

`make qa-install QA_PLATFORM=linux/arm64`:

```text
PASS 1 build working-tree image
PASS 2 empty mounts, API health and Docker healthy
PASS 3 unclaimed status
PASS 4 guarded claim and setup-token removal
PASS 5 tagged Unicode MP3, full media and Range
PASS 6 restart persists name, account and song
PASS 7 requested UID, host mode 0600 and confined writes
PASS 8 logs contain no Traceback/ERROR
PASS 9 cleanup container and temporary directories
```

`make qa-install QA_PLATFORM=linux/amd64`:

```text
PASS 1 build working-tree image
PASS 2 empty mounts, API health and Docker healthy
PASS 3 unclaimed status
PASS 4 guarded claim and setup-token removal
PASS 5 tagged Unicode MP3, full media and Range
PASS 6 restart persists name, account and song
PASS 7 requested UID, host mode 0600 and confined writes
PASS 8 logs contain no Traceback/ERROR
PASS 9 cleanup container and temporary directories
```

Files changed:

- `backend/Dockerfile`, `backend/Dockerfile.dockerignore`, `backend/ffmpeg-build.sh`: selected FFmpeg build and runtime packaging.
- `backend/requirements-server.txt`, `backend/requirements-runtime.txt`, `backend/tests/unit/test_dependency_pins.py`: shared pins and preserved standalone/desktop fallback.
- `scripts/qa/install.py`, `Makefile`: disposable QA runner and `make qa-install`.
- `.github/workflows/ci.yml`: cached amd64 clean-install job.
- `docs/qa-install.md`: usage, build rationale, licensing and local evidence.
