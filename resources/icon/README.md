# Flipspin app icon

The penguin is drawn in two SVG sources; every PNG is rendered from them.

| File | What it is | Consumed by |
|---|---|---|
| `krobi-icon.svg` | the icon: penguin on Flipspin blue `#2F6FE0`, full bleed | `render.mjs` |
| `krobi-figure.svg` | the penguin alone, transparent | `render.mjs`; the Android client's adaptive foreground (background colour `#2F6FE0`) |
| `krobi-1024.png` | `krobi-icon.svg` at 1024, no alpha | `npx tauri icon` → `src-tauri/icons/` (png, ico, Windows tiles); the iOS client's `AppIcon.png` verbatim (iOS masks it itself) |
| `krobi-macos-1024.png` | the icon on Apple's Big Sur grid: 824 px rounded square, soft shadow | `make-macos-icns.sh` → `src-tauri/icons/icon.icns` |
| `krobi-figure-1024.png` | `krobi-figure.svg` at 1024, transparent | the phone clients, when a raster is easier than the SVG |

`render.mjs` also writes the sidebar mark, `renderer/src/assets/krobi-mark.png`.
It renders with Chromium (Playwright), because ImageMagick's SVG renderer drops
some strokes and nested transforms.

```bash
node resources/icon/render.mjs            # every PNG master + the sidebar mark
npx tauri icon resources/icon/krobi-1024.png -o src-tauri/icons && rm -rf src-tauri/icons/{android,ios}
bash resources/icon/make-macos-icns.sh    # the icns, after tauri icon (which overwrites it)
node scripts/make-readme-shots.mjs        # the README screenshots show the sidebar mark
```
