This directory holds generated desktop resources. Keeping it in a clean checkout
lets Tauri compile debug builds and tests before packaging.

`npm run build:backend` stages the server and ffmpeg; `npm run build:desktop`
stages uv and the helper, compatibility and native KeyFinder wheels. Installer
builds require a host C/C++ compiler for KeyFinder.
