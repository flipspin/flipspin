# Asset inventory

Inventory of the current tree for publication. It includes all non-code files
in `resources/`, `renderer/public/`, the renderer's `assets` directories,
images in `docs/`, and native icons. It excludes user-downloaded content and
executable dependencies: their notices are in
[third-party notices](third-party-notices.md).

Each file's `git log --follow`, adjacent notes, existing notices, and font
and SVG metadata were reviewed. The cited commits refer to the private history
before the export; that history and its old blobs must not be published.
A statement in the notices alone does not prove the provenance of an external
component.

## Provenance and licenses

**Flipspin penguin.** The app icon and sidebar mark are original project work
and are licensed under AGPL-3.0-or-later, like the code. The sources are two
SVGs (`krobi-icon.svg`, with a background, and `krobi-figure.svg`, without
one). Every PNG is rendered from them with `resources/icon/render.mjs` and the
scripts described in `resources/icon/README.md`.

In the tables, **Penguin¹** means: project work, AGPL-3.0-or-later.

| File | Origin / author | License / evidence |
|---|---|---|
| `resources/icon/krobi-icon.svg` | Penguin¹, vector source with a background | AGPL-3.0-or-later |
| `resources/icon/krobi-figure.svg` | Penguin¹, vector source without a background | Same |
| `resources/icon/krobi-1024.png` | Penguin¹, `render.mjs` | Same |
| `resources/icon/krobi-macos-1024.png` | Penguin¹, `render.mjs` (macOS grid) | Same |
| `resources/icon/krobi-figure-1024.png` | Penguin¹, `render.mjs` (no background) | Same |
| `resources/icon/README.md` | Project documentation | AGPL-3.0-or-later |
| `resources/default-songs/README.md` | Project policy; directory contains no audio | AGPL-3.0-or-later; `b423cd9`. No sample music is distributed |
| `renderer/src/assets/krobi-mark.png` | Penguin¹, `render.mjs` (sidebar mark) | AGPL-3.0-or-later |
| `docs/images/screenshot-home.png`, `home-dark.png` | Real app, fictional fixture, and procedural SVG covers (`scripts/readme-covers.mjs`) from `scripts/make-readme-shots.mjs`; light and night | AGPL-3.0-or-later for the fixture/new artwork; contains Penguin¹ |
| `docs/images/screenshot-album.png` | Same script; album page, 1440×900, light | Same; contains Penguin¹ |
| `docs/images/screenshot-lyrics.png`, `screenshot-stems-panel.png`, `screenshot-onboarding.png`, `screenshot-visualizer.png` | Same script; lyrics, stems panel (2×), first launch, full-screen visualizer | Same |
| `docs/images/screenshot-settings-panel.png`, `screenshot-accounts-panel.png`, `screenshot-remote-access-panel.png` | Same script; standalone "Settings" (Settings) pages (2×), without the shell | Same; fictional home and devices |
| `docs/images/screenshot-explore-home.png` | Same script; "Explore" (Explore). Fictional album and artist names; Deezer featured playlist names with original generic covers | Same, except for genre photos: Deezer catalog images, downloaded during generation and not saved in the repo |
| `docs/images/readme-cover-light.png`, `readme-cover-dark.png` | README cover: `scripts/readme-cover/make_cover.py` (halftone Penguin¹ + home and album screenshots) and `lockup.mjs` (Inter, OFL) | AGPL-3.0-or-later; contains Penguin¹ |
| `docs/images/spotify-import.png` | Pixel character and folder drawn by the project author; halftone Penguin¹ | AGPL-3.0-or-later |
| `docs/images/opensubsonic.svg` | OpenSubsonic project logo, used only to name the compatible API | Its project's trademark; not relicensed |

Screenshots are regenerated with `node scripts/make-readme-shots.mjs` after
installing npm dependencies and Playwright's Chromium (`npx playwright
install chromium`). The real renderer is served with Vite; only HTTP responses
are replaced. The account and music names are fictional. The covers are built
locally with circles, strokes, and colors. They do not use
image services, commercial covers, or personal libraries.

### Native icons

All are **Penguin¹**, AGPL-3.0-or-later.

| File in `src-tauri/icons/` | Generation / evidence |
|---|---|
| `32x32.png` | `tauri icon` from `krobi-1024.png` |
| `64x64.png` | `tauri icon` from `krobi-1024.png` |
| `128x128.png` | `tauri icon` from `krobi-1024.png` |
| `128x128@2x.png` | `tauri icon` from `krobi-1024.png` |
| `icon.png` | `tauri icon` from `krobi-1024.png` |
| `icon.ico` | `tauri icon` from `krobi-1024.png` |
| `icon.icns` | `make-macos-icns.sh` from `krobi-macos-1024.png` |
| `Square30x30Logo.png` | `tauri icon` from `krobi-1024.png` |
| `Square44x44Logo.png` | `tauri icon` from `krobi-1024.png` |
| `Square71x71Logo.png` | `tauri icon` from `krobi-1024.png` |
| `Square89x89Logo.png` | `tauri icon` from `krobi-1024.png` |
| `Square107x107Logo.png` | `tauri icon` from `krobi-1024.png` |
| `Square142x142Logo.png` | `tauri icon` from `krobi-1024.png` |
| `Square150x150Logo.png` | `tauri icon` from `krobi-1024.png` |
| `Square284x284Logo.png` | `tauri icon` from `krobi-1024.png` |
| `Square310x310Logo.png` | `tauri icon` from `krobi-1024.png` |
| `StoreLogo.png` | `tauri icon` from `krobi-1024.png` |

### Bundled fonts and notices

The TTF files have copyright and OFL 1.1 license information in their `name`
table. They were checked against upstream notices; the binaries were not modified.
The WOFF/WOFF2 files from npm are those imported by the stylesheets in `renderer/src/main.tsx`.
Each full notice is copied from `renderer/public/fonts/` into the renderer build
and included in the desktop frontend; it does not rely on publishing only the README.

| File / set | Origin and author | License and bundled file |
|---|---|---|
| WOFF/WOFF2 imported from `@fontsource/inter` | Rasmus Andersson / Inter Project Authors; package pinned in `package-lock.json` | OFL-1.1; [`OFL-Inter.txt`](../renderer/public/fonts/OFL-Inter.txt), copy of `@fontsource/inter/LICENSE` |
| WOFF/WOFF2 imported from `@fontsource/geist` | Vercel / Geist Project Authors; package pinned in `package-lock.json` | OFL-1.1; [`OFL-Geist.txt`](../renderer/public/fonts/OFL-Geist.txt), copy of `@fontsource/geist/LICENSE` |
| WOFF/WOFF2 imported from `@fontsource/geist-mono` | Vercel / Geist Project Authors; package pinned in `package-lock.json` | OFL-1.1; [`OFL-GeistMono.txt`](../renderer/public/fonts/OFL-GeistMono.txt), copy of `@fontsource/geist-mono/LICENSE` |
| `renderer/public/fonts/README.md` | Project documentation | AGPL-3.0-or-later |

### Other non-code data in the repository

| File / set | Origin and author | License / evidence |
|---|---|---|
| `backend/tests/fixtures/spotify_export/account_data/Read_Me_First.pdf` | Synthetic project text stub, not Spotify's PDF | AGPL-3.0-or-later; literal content `%PDF-1.4 placeholder`, `7c86a09` |
| `backend/tests/fixtures/spotify_export/extended_streaming_history/ReadMeFirst_ExtendedStreamingHistory.pdf` | Synthetic project text stub | AGPL-3.0-or-later; `7c86a09` |
| Fixture, contract, and translation JSON | Project test/configuration data; the Spotify notes document the reference layout | AGPL-3.0-or-later; not covers or audio files |

Almost all Lucide icons are components from the `lucide-react` dependency
(ISC). A few are drawn inline by copying their strokes (file picker,
first launch and remote access, each song's Play control, and the "+" in catalog
rows; the globe is the earlier Feather drawing, MIT). The full ISC notice
is in [third-party notices](third-party-notices.md). No other
images, fonts, or audio are tracked in the inventoried public directories.
Internal mocks already tracked require review during the export;
they are not part of the packaged frontend. No assets have been deleted and
no historical objects have been rewritten.
