# Packaging

The Flipspin desktop app packages a Tauri 2 native shell, the Vite renderer, and a PyInstaller
FastAPI executable. Build on the target operating system; PyInstaller output is
platform-specific; build each installer on its target OS and architecture.

## Prerequisites

- Node.js 22+ and `npm install`
- Rust stable with the target platform toolchain
- Python 3.12 in the repository-root `.venv`
- dependencies from `backend/requirements.txt`, including PyInstaller

## Build

```bash
npm run dist:mac  # PyInstaller backend + Vite + Tauri DMG
npm run dist:win  # PyInstaller backend + Vite + Tauri NSIS installer
npm run dist:linux # PyInstaller backend + Vite + Tauri AppImage and deb
```

`npm run build:backend` writes `krobi-backend` (or `.exe`) and the matching
`imageio-ffmpeg` binary to `src-tauri/resources/backend/`. Tauri bundles that
directory plus `resources/default-songs/`; when a local nest is chosen, the
Rust supervisor starts the backend on `0.0.0.0:8000` with a setup token. A
remote nest uses its own server.

Use `npm run build` for a renderer-only build and `cargo check --manifest-path
src-tauri/Cargo.toml` to validate the native shell without packaging.

## Linux desktop builds

The manual **Build desktop app** workflow accepts `platform: linux`. It builds
unsigned x86_64 AppImage and Debian packages on **Ubuntu 22.04** (glibc 2.35),
then uploads both as the `krobi-linux-<sha>` Actions artifact. It does not
publish a release. Use this baseline when building for distribution: building
on a newer distro may require a newer glibc on users' machines. See Tauri's
[AppImage requirements](https://v2.tauri.app/distribute/appimage/).

On a fresh Ubuntu 22.04 x86_64 checkout, install Node.js 22+, Rust stable and
Python 3.12, then run:

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libssl-dev libxdo-dev build-essential \
  curl wget file pkg-config patchelf libfuse2 xdg-utils \
  gstreamer1.0-tools gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
npm ci
npm run dist:linux
```

Use independent dependencies in this checkout; do not install through `.venv`
or `node_modules` symlinks to another checkout. Native Linux arm64 source
builds are also handled by the staging scripts, but the manual workflow
produces x86_64 only.

The dist script builds the backend first. Tauri's `beforeBuildCommand` then
runs `build:desktop`: verified, pinned Linux uv → skip the unsupported Mac
lyrics wheel (remove stale wheels) → Vite. `imageio-ffmpeg` supplies the native
FFmpeg executable at `backend/ffmpeg/ffmpeg` with execute permissions; a
missing or unrunnable binary fails the build. The PyInstaller hook excludes
an embedded copy. The shell prepends bundled `backend/bin` (uv) to the
backend's `PATH`; ffmpeg stays off it so an installed binary wins.
AppImages bundle GStreamer for playback; Debian packages declare the matching
runtime packages so `apt install ./...deb` installs them.

Outputs:

- `src-tauri/target/release/bundle/appimage/*.AppImage`
- `src-tauri/target/release/bundle/deb/*.deb`

For a container build with no FUSE mount, set `APPIMAGE_EXTRACT_AND_RUN=1`.
Containers need their own Linux dependencies and Python venv; never reuse
host build artifacts. No Linux signing keys or extra signing steps are needed.

Linux can host a local nest or connect to a remote one. The lyrics/stems ML
engine remains **Apple Silicon macOS only**: it is not bundled on Linux and
engine install/start returns `unsupported-platform`. A Mac connected to the
same nest can process its queue. Linux uses the hostname for the device name,
does not install a Mac sleep hook or worker tray, and does not ask for macOS
Local Network permission. Native file pickers and the mini-player use Tauri's
cross-platform APIs. Installation and removal: [INSTALL.md](INSTALL.md#linux).

## macOS distribution policy

Distribute the app directly as a **Developer ID signed and Apple-notarized
DMG**; do not submit it to the Mac App Store. Until signing credentials supply the
credentials, the tag release workflow permits unsigned DMGs and labels them
in the release notes; see [RELEASE.md](./RELEASE.md#optional-macos-signing). App Review guidelines 5.2.2 and
5.2.3 can require authorization from third-party services and media sources
that an acquisition feature like this one would have to show. Notarization
is a separate automated security/signing check, not App Review.

The release Mac needs a `Developer ID Application` certificate (an `Apple
Development` identity is insufficient for public distribution). Confirm it with:

```bash
security find-identity -v -p codesigning
```

Set `APPLE_SIGNING_IDENTITY` and either Tauri's App Store Connect API variables
(`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) or its Apple-ID
notarization variables, then run `npm run dist:mac`. See Tauri's
[macOS signing guide](https://v2.tauri.app/distribute/sign/macos/). Keep every
certificate, private key and password outside the repository.

## Outputs and release checks

Tauri writes installers under `src-tauri/target/release/bundle/`. Before
publishing, install the artifact on a clean machine and verify startup, audio
playback and seeking, downloads, the mini-player, local directory selection,
remote-server login, and clean backend shutdown. For macOS, also verify the
actual release artifacts:

```bash
codesign --verify --deep --strict --verbose=2 path/to/Flipspin.app
spctl --assess --type execute --verbose=4 path/to/Flipspin.app
xcrun stapler validate path/to/Flipspin.dmg
```

Windows code signing is likewise a release-environment concern; never commit
signing credentials.

A development build signed with a stable identity (for example an `Apple
Development` certificate via `APPLE_SIGNING_IDENTITY`) also keeps macOS's Local
Network permission across rebuilds; an ad-hoc signature changes identity on
every build, so the first launch after each rebuild is denied LAN access.
