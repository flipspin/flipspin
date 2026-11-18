# Upgrading and backups

Flipspin 0.1.0 is a beta. Read the target version's
[release notes](https://github.com/flipspin/flipspin/releases) before every upgrade,
including any data changes or extra steps.

## Back up first

1. Stop the nest (server): `flipspin stop` for the one-line installer,
   `docker compose stop krobi` for Compose, or quit the desktop app when it
   hosts the nest. Keep it stopped while copying the data.
2. Copy the **entire data folder** to a separate backup location. For Docker,
   copy the contents of the volume or host folder mounted at `/data` (including
   the `Krobi` subfolder). For a desktop nest, copy the resolved data root
   shown in the startup log (see [configuration](CONFIGURATION.md#data-root)).
   Include hidden files, credentials and permissions. For the one-line installer, also save `/opt/krobi/.env` and
   `/opt/krobi/compose.yml` so you can recover its paths and pinned version.
3. Back up your **music folder separately** if it lives outside the data folder,
   such as the `/music` mount or a custom library path. If it is inside
   `<root>/Music`, include it in the copy. Keep the backup until you have
   checked the upgraded nest and your library.

## Choose and install a version

Pin a version when you want to choose when to upgrade. GitHub release tags use
`v0.1.0`; image tags and `KROBI_TAG` use `0.1.0`, without the `v`.

- **One-line installer:** for a new install, download
  [`deploy/install.sh`](../deploy/install.sh) and run
  `KROBI_TAG=0.1.0 sh install.sh`. For an existing install, set
  `KROBI_TAG='0.1.0'` in `/opt/krobi/.env`, then run `flipspin update`.
  The saved tag controls updates; setting it only in your shell does not
  override the saved configuration.
- **Docker Compose / Unraid:** set the image to
  `ghcr.io/flipspin/flipspin-server:0.1.0`. For Compose, run
  `docker compose pull && docker compose up -d`; for Unraid, apply the image
  tag change in the container settings.
- **Desktop:** quit the app, install the chosen release's installer, then
  reopen it. See [INSTALL.md](INSTALL.md) for unsigned-build prompts.

With `KROBI_TAG='latest'` in the installer's saved configuration, `flipspin update`
follows the newest regular release. An image ending in `:latest` follows that
moving tag when you pull it. A pinned version stays on that version until you
change it. After upgrading, check that the nest starts and your library and
accounts are present.

## If the upgrade fails

If an upgrade's data step fails, the server refuses to start rather than risk
losing data. The startup log line explains why it stopped. Check `flipspin logs`,
`docker compose logs flipspin`, or the desktop nest's `<root>/logs/`. See
[observability.md](observability.md) for log locations and troubleshooting.

To roll back:

1. Stop the nest again. Keep a separate copy of the failed upgrade's data and
   logs if you need them for troubleshooting.
2. Select the previous version's tag using the same pinning steps above, or
   reinstall the previous desktop installer.
3. Restore the **pre-upgrade data backup** to the same data folder or volume,
   preserving permissions, before starting the previous version. Restore the
   matching music backup too if the release changed music files. Switching the
   image tag alone does not undo data changes.
4. Start the nest and check your library and accounts. For the one-line
   installer, run `flipspin update` after restoring the backup to apply the
   previous pinned tag; for Compose, pull and recreate the container.

## Desktop rename

Flipspin uses the bundle identifier `app.flipspin.desktop`. Quit the previous
app before opening Flipspin for the first time; keep both closed while backing
up. With an empty new store and an existing old one, startup copies the old
store before opening any window. It never removes or changes the original.
An existing new store is left alone. Allow additional disk space for the copy.

On macOS the copied roots are:

- `~/Library/Application Support/app.krobi.desktop/` → the corresponding
  `app.flipspin.desktop/` directory, including `preferences.json`, credential
  metadata, explicit private token files, window placement and offline storage.
- `~/Library/Caches/app.krobi.desktop/` → `app.flipspin.desktop/`, including
  the media cache.
- `~/Library/WebKit/app.krobi.desktop/` → `app.flipspin.desktop/`, including
  the complete persistent WebKit localStorage store, salt and SQLite sidecars.

Windows copies the equivalent identifier directories under `%APPDATA%` and
`%LOCALAPPDATA%`, including WebView2 data. Linux uses the configured XDG data
and cache directories (normally `~/.local/share/` and `~/.cache/`). Managed
absolute offline-file paths are rebased in the copied SQLite database; imported
external-file paths stay unchanged. Server files stay in the resolved data root.

Vault accounts under service `app.krobi.desktop` are read and verified under
`app.flipspin.desktop`: every account in `credentials.json` (server tokens,
`worker:*` tokens and `headers:*` secrets), plus `nest-secret-key:local`.
Old items remain. A locked vault, conflicting new credential, failed write or
copy error stops startup; unlock the vault, check free space, and retry. No
secrets or personal paths appear in the migration log. Symlinks in the old
store stop the copy rather than following them outside that store.

A pending marker allows an interrupted migration to resume. A completion marker
prevents rerunning it or restoring old preferences over later changes. One
`Flipspin desktop migration completed; previous data retained` message appears
in the desktop log after successful migration. macOS may ask again for Local
Network access and keychain access because the app identifier changed.

Tauri does not expose a localStorage import API for WKWebView. Copying its
persistent directory before creating the webview preserves the same origins
and keys. See [Tauri's data-directory support](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html#method.data_directory)
and [WebKit's store implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebsiteData/Cocoa/WebsiteDataStoreCocoa.mm).
Live migration across supported OS versions still needs installer QA. If an OS
stores WebKit data outside those roots, its localStorage cannot be imported by
this migration. The following host keys would reset in that case (the old
app's data remains recoverable):

| Keys | What resets |
|---|---|
| `krobi.language`, `krobi.mode`, `baseDir` | Language, appearance and local device preferences |
| `playerQueue`, `playerQueueBase`, `playerQueueIndex`, `playerNowPlaying`, `playerShuffleEnabled`, `krobi.player.position` | Queue, shuffle and resume position |
| `preferredVisType`, `preferredSvgStyle`, `preferredAudioStyle`, `krobi.outputVolume`, `krobi.volumeLevelling`, `krobi.mix` | Playback display, volume and stem mix |
| `krobi.sidebarPlaylistsCollapsed`, `krobi.sidebarFolded`, `krobi.homeRailFolded`, `krobi.recentAlbums.layout` | Sidebar and home layout |
| `krobi.libraryView`, `krobi.libraryGroupMode`, `krobi.librarySearch.collapsedGroups`, `krobi.album.masDeOpen`, `krobi.playlists.view` | Library/playlist layout |
| `krobi.recentLibrarySearches`, `krobi.recentCatalogSearches`, `krobi.recentSearches`, `krobi.playHistory`, `krobi.playHistory:<origin>` | Device search and play history |
| `krobi.songTable.hiddenColumns`, `krobi.songTable.columnOrder`, `krobi.songTable.columnWidths`, `krobi.songTable.covers`, `krobi.tags.skipSingleConfirmation` | Song table and tag-confirmation preferences |
| `krobi.settings.menu.<JSON [nest, viewer]>`, `krobi.setup-remote.<instanceId or origin>`, `krobi.setup-link-code` | Settings groups and pending setup choices/code |
| `krobi.isingCollapsed`, `krobi.ondaViewMode`, `krobi.ondaIdleWave`, `krobi.vizMotion`, `krobi.vizLock`, `krobi.vizParams.v2`, `krobi.vizTilt.v2` | Visualizer preferences |
| `krobi.lyricsBackdrop`, `krobi.lyricsWaveOpen`, `krobi.localLyrics` | Lyrics display preferences |

Retired keys `theme`, `ftpUrl`, `ftpPassword` and `phoneDownloadPath` are removed
by existing startup cleanup. Optional plugins may own additional keys; the host
cannot enumerate them, so the whole WebKit directory is copied. Native account
credentials, offline files and the server library do not depend on localStorage.
