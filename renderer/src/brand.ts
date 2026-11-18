/**
 * The name a person sees.
 *
 * Window title, dock name and installer name live in `src-tauri/tauri.conf.json`
 * (`productName`) and `src-tauri/Info.plist`; they cannot import this file.
 */
export const APP_NAME = 'Flipspin'

/** The first-run wizard uses the image published by .github/workflows/server-image.yml on release tags. */
export const SERVER_IMAGE = 'ghcr.io/flipspin/flipspin-server'

/** Linux server installer shown by the first-run wizard. */
export const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/flipspin/flipspin/main/deploy/install.sh'
