# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1]

Fixes and polish from testing 0.1.0 on Windows, plus dependency security
updates. Upgrade in place; your library and accounts stay as they are.

### Downloads

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Flipspin_0.1.1_aarch64.dmg` |
| Windows (x64, preview) | `Flipspin_0.1.1_x64-setup.exe` |
| Linux (x64, preview) | `Flipspin_0.1.1_amd64.AppImage` or `.deb` |
| Server (Docker, amd64 and arm64) | `ghcr.io/flipspin/flipspin-server:0.1.1` |

The desktop builds are still unsigned; [INSTALL.md](https://github.com/flipspin/flipspin/blob/main/docs/INSTALL.md) shows how to
open them.

### Changed

- **Remote access:** every way in is one list, and each one's setup opens as
  steps in a popup. The home-network route is worked out from the server's
  real network, and Tailscale links match the server's system.
- **Accounts:** passwords need 8 characters or more (was 10). An owner can
  create accounts that sign in by name, and a password reset asks for the
  username first.
- **Add-ons:** each card's header says its state on this computer. Lyrics and
  Stems stay muted until the shared engine is installed.
- **Downloads:** a failed song says what happened and offers what helps; a
  paused source says why and until when; a gone candidate falls through to the
  next one.
- **Windows:** the app header is the title bar.
- **Settings:** sources come first in the menu, and each source plugin has one
  card with all its controls.

### Fixed

- A new desktop install keeps music in the OS music folder
  (`Music/Flipspin`), not inside the app's data folder. Existing libraries
  stay where they are.
- A failed add-on download no longer leaves the add-on looking installed, and
  its error shows on its card.
- Nest-wide settings and logs are for owners only.

### Security

- Updated anyio, certifi, cffi, cryptography, lxml, python-multipart,
  soupsieve, typing_extensions and urllib3 in the server.

## [0.1.0]

The first public release of Flipspin: a self-hosted music server with a desktop
app, for the library you already have. This is a **beta**: macOS has been
tested hands-on with the server; the Windows and Linux builds are previews.
Read [Known issues](https://github.com/flipspin/flipspin/blob/main/docs/known-issues.md) before installing, and back up your data
folder before upgrading.

### Downloads

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Flipspin_0.1.0_aarch64.dmg` |
| Windows (x64, preview) | `Flipspin_0.1.0_x64-setup.exe` |
| Linux (x64, preview) | `Flipspin_0.1.0_amd64.AppImage` or `.deb` |
| Server (Docker, amd64 and arm64) | `ghcr.io/flipspin/flipspin-server:0.1.0` |

The desktop builds are unsigned; [INSTALL.md](https://github.com/flipspin/flipspin/blob/main/docs/INSTALL.md) shows how to
open them on macOS and Windows. The one-line server install is in the
[README](https://github.com/flipspin/flipspin#install).

### What's in it

- **Your library as it is:** albums at any folder depth, files never moved or
  renamed.
- **Several people, one server:** owner and member accounts, a personal library
  and playlists each, one revocable token per device.
- **OpenSubsonic API:** existing Subsonic and OpenSubsonic apps work as phone
  clients, with synced lyrics.
- **Synced lyrics** from LRCLIB, or aligned to the vocals when only the words
  are known, saved as `.lrc` beside the audio.
- **Stems, key and tempo** computed on your own computers acting as helpers
  (Apple Silicon, Nvidia or CPU).
- **Catalog browsing** with the songs you own marked, Spotify import from the
  privacy export, and audio sources as plugins installed from Settings.
- **Remote access** through Tailscale, WireGuard or a domain with HTTPS.

### Not in this release

- Native iPhone and Android apps (use an OpenSubsonic client).
- Lyrics transcription; lyrics are synced only.

[Unreleased]: https://github.com/flipspin/flipspin/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/flipspin/flipspin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/flipspin/flipspin/releases/tag/v0.1.0
