# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Point public links, update checks, downloads and the server image at the Flipspin repository, migrate saved installer images, and release helper 0.15.8.

- **Safe release publishing** — build images by digest, upload and
  attest complete draft assets with SHA256SUMS, then promote and publish with
  explicit latest selection and anonymous verification. Installer updates pull
  the published version while retaining follow mode; helpers come from that tag.

- **Version reset to 0.1.0** for the first public alpha release (was 2.1.2 in the
  private history), so the update notice compares nests against public tags.

### Added

- **Tag-driven releases** — a `v*` tag checks all four version sources, pushes
  the server image for amd64 and arm64, builds every desktop installer, then
  publishes the GitHub release. Prereleases stay out of the nest's update feed;
  unsigned macOS builds are labelled in the release notes.

- **Owner-only update notice** — Ajustes shows newer nest releases, the correct
  command for the declared install, release notes, and a manual check. Daily
  GitHub checks retain the last good version on failure; turn them off in
  Avanzado or with `KROBI_UPDATE_CHECK=false`.

- **Linux desktop installers** — AppImage and Debian packages via
  `npm run dist:linux` or the manual build workflow on Ubuntu 22.04, with bundled
  backend, FFmpeg and uv, plus playback codec dependencies. The Apple Silicon
  lyrics/stems engine remains unavailable on Linux; a connected Mac can process its queue.
- **«¿Dónde está tu nido?» / "Where's your nest?"** — the desktop app's first
  screen. The *nest* is what the app now calls the KROBI server. **On this
  computer** makes this computer the nest; **On another computer** lists the
  nests found on the local network, or takes a typed address. Then the first
  account is created (or you sign in), and on a nest on this computer
  **Your music** asks once for the music folder. A fresh install starts no
  server until the question is answered; existing installs are migrated and
  never see it.
- **LAN discovery.** A claimed server announces itself over mDNS as
  `_krobi._tcp` (never while its claim is still open); `KROBI_ADVERTISE=false`
  turns it off. mDNS does not cross a VPN, so away from home the typed address
  is the way in.
- **The nest has a name.** `GET /api/status` gains `name` (additive); the owner
  renames it with `PUT /api/server/name` or from Settings → Nest; the claim
  accepts an optional `nestName`, which the desktop sets to «Nido de <computer
  name>».
- Pairing a phone with a QR code now works when this computer is the nest: the
  code carries the computer's LAN address, and the app refuses to draw one with
  a loopback address.

### Changed

- **One redistributable ffmpeg.** Desktop installers now carry only
  imageio-ffmpeg's GPL binary and refuse nonfree builds. Downloads, the editor,
  normalization and analysis share the selected executable: configured path,
  installed ffmpeg, then bundled fallback. Owners can view its path, version
  and source and change the path live in Ajustes → Avanzado.

- **Krobi phone apps are coming soon.** Use OpenSubsonic apps for
  mobile today. The first-run wizard disables the Krobi choice as «Próximamente»
  and selects Subsonic app passwords; it no longer mints a Krobi pairing QR or
  device. Settings → My account QR pairing stays available for sideloaded clients.

- Removed the browser client and server-hosted renderer. Connect with the desktop,
  iOS, Android or OpenSubsonic apps; the installer prints an address and setup
  code for the desktop app. Sign-in codes use device approval or typed entry.

- A desktop that signs in names its device after the computer («Mac de Robin»)
  instead of the generic «MacBook Pro» every machine used to get.
- Settings → Server is now Settings → Nest, with an owner rename and
  «Change nest».

### Security

- The packaged server ignored `--host` and always listened on `0.0.0.0`, so a
  fresh, unclaimed desktop install could be claimed by anyone on the same
  network. It now honours `--host`/`--port`; the desktop starts its nest on
  `0.0.0.0` deliberately, with `KROBI_REQUIRE_SETUP_TOKEN=true`, and passes the
  setup code to its own account-creation screen.

### Removed

- The Fourier decomposition view is out of the sidebar and tab bar until it is
  redesigned; its code stays in the tree.
- **Sending songs to a phone** — over FTP (`/api/transfer-to-android`,
  `/api/send-to-android`, `/api/android-ftp-credentials`,
  `/api/test-ftp-connection`) and as a QR download page (`/api/local-share…`,
  which was the one tokenless path besides the handshake). The KROBI phone apps
  and Subsonic clients replace both. The FTP settings, the phone folder and
  the «Enviar a → Teléfono» entries are gone; «Enviar a → VLC» stays.
  `KROBI_FTP_RETRY_ATTEMPTS` is no longer read.

## [2.1.2] - 2026-09-28

First public release, as **KROBI**. This entry describes the state of the
project at publication rather than its history.

### Added

- **Self-hosted server** (FastAPI) that owns the music library, playlists and
  accounts, and can run on a separate machine: a Linux box, VM or container with
  systemd, or Docker. See `docs/deployment.md`.
- **Desktop app on Tauri 2** (Rust shell + React/TypeScript renderer) for macOS
  and Windows. It either runs a bundled copy of the server on the same machine
  or connects to a remote one (chosen in Settings → Server).
- **Accounts and devices.** The first account claims a new server and becomes
  its owner (optionally gated by a setup code); the owner adds household
  members; each device holds its own revocable token; sign-in with username and
  password adds a new device. Devices can be paired with a QR code.
- **Per-user libraries** over one shared catalog on disk: saving a song links it
  to your account without copying it, and playlists belong to their creator.
- **Catalog browsing** of albums, artists and playlists from the enabled
  metadata providers, with markers for tracks already in the library, and
  acquisition of the rest from sources you configure.
- **Provider registry**: metadata, lyrics and acquisition sources enabled and
  ordered from Settings → Sources.
- **Lyrics**: synced and plain lyrics fetched from LRCLIB and Genius, stored as
  `.lrc`/`.txt` files beside the audio, with a hand-edit lock; an optional
  on-device engine (Apple Silicon) transcribes or aligns lyrics that the
  catalogs do not have, also on behalf of a remote server.
- **Spotify data-export import**: parse the "Download your data" archive,
  resolve each track against Deezer and MusicBrainz with a human review step,
  then import.
- **Interface in Spanish and English**, following the system language, with a
  switch in Settings → General → Language.
- Audio editor, Fourier decomposition view, tempo/key analysis (optionally
  written to tags), transfers to a phone or a network speaker, and audio-CD
  burning.

[Unreleased]: https://github.com/flipspin/flipspin/compare/v2.1.2...HEAD
[2.1.2]: https://github.com/flipspin/flipspin/releases/tag/v2.1.2
