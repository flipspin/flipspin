# Working on the native shell

Paths are repository-relative. `src-tauri/src/main.rs` and
`src-tauri/src/lib.rs` are entry and app builder. The desktop module is split
under `src-tauri/src/desktop/`: mod.rs holds state, bridge.rs dispatches channels,
nest.rs/nest_process.rs manage the backend, handshake.rs/discovery.rs/connection.rs
handle discovery and address selection, prefs.rs/credentials.rs persist state,
proxy/ guards JSON and media requests, downloads.rs saves device copies, player.rs relays
the second window. `src-tauri/crates/krobi-offline/` owns offline storage and
transfer policy, adapted by `src-tauri/src/desktop/offline/`. Add behavior in
the owning module.

## Server and credential lifetime

Server choice is explicit: the backend-URL environment override locks it,
otherwise use persisted choice or unchosen. Unchosen probes/spawns nothing.
Accept only the Flipspin handshake, adopt an existing local backend, and keep port
8000 fixed rather than walking to another port and starting a second writer.
Debug builds never spawn; use `make backend` then `make tauri`. Packaged child
servers bind for LAN access with setup-token protection. Never stop an adopted
server as though it were our child.

Keep identity metadata atomic and private, keyed by backend identity (local
mode has a stable local key). Tokens use the OS vault; vault failure keeps them
in session memory unless the person explicitly chooses private file storage.
Announce auth changes to every window. Resolve the fallback secret when signing
out, rather than caching one credential forever. The local setup token is
available only in child mode.

## Native boundary and transports

Keep typed channels aligned with `renderer/src/lib/ipc.ts` and its
adapter in `renderer/src/desktop/tauri.ts`. New renderer consumers go through
`renderer/src/bridge.ts`. Keep desktopAPI compatibility for legacy UI. Renderer file moves must not
rename channel strings, persisted storage keys or native payload fields.
Plugin host access is documented in `docs/PLUGINS.md`; its stable renderer
entry is `renderer/src/plugins/host.ts`.

JSON forwarding must stay within the configured origin and path prefix, with
no userinfo bypass. Add credentials in Rust. Multipart bodies are encoded by the
renderer and carried as bytes through the same proxy. Custom proxy headers use the credential vault/file policy and
are injected by the scoped Rust client; never return saved values to a window.
The krobi-media scheme only accepts GET/HEAD under the media namespace. GET responses buffer bounded byte
slices; preserve probes, range headers, 416 and older-server fallback behavior.
Do not put the desktop token in media URLs. Device downloads validate the same
backend namespace, stream to a sibling .part and rename on completion; their
index is scoped to backend and media path.

## Helpers and packaging

`src-tauri/src/lyrics/` installs/supervises the helper. Use bundled uv and
managed CPython; a bundled system interpreter can receive different macOS LAN
permissions. Helpers use enrolled helper-device tokens and die with the shell.
Handle auth changes, sleep/quit goodbye, and hold awake only while working.
Tray, sleep and awake behavior lives in `src-tauri/src/worker_tray.rs`,
`src-tauri/src/sleep.rs` and `src-tauri/src/keep_awake.rs`.

The release offers lyrics sync only, with no transcription. Preserve selected
helper extras on upgrades; analysis does not require the full lyrics/stems
engine. Bundle configuration is `src-tauri/tauri.conf.json`; capabilities are
in `src-tauri/capabilities/`. Keep macOS LAN/mDNS declarations in
`src-tauri/Info.plist`. Build frontend-only changes with `npm run build:frontend`;
backend binaries require `npm run build:backend` before full packaging.

## Testing

Run `make test-rust` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.
`make lint` includes Clippy. Shared address/probe behavior follows
`contracts/remote-access.json`; changing it requires the other consumers too.

## What guards these rules

| Rule | Guard |
|---|---|
| Rust types and module ownership | Cargo and Clippy; module placement not enforced yet |
| Server adoption, choice and child lifetime | Desktop tests via `make test-rust`; debug startup compile-time branches |
| Private metadata and credential lifetime | Tests in `src-tauri/src/desktop/credentials.rs` and `src-tauri/src/desktop/private_file.rs` |
| Typed channels and compatible payloads | Rust tests, TypeScript and renderer bridge tests; complete cross-language parity not enforced yet |
| Origin-scoped proxy, media and downloads | Proxy/download tests via `make test-rust` |
| Helper install, auth changes, sleep and shutdown | Rust/helper process tests; OS permission behavior not enforced yet |
| Packaging and native permissions | Build drivers and Rust tests; permission prompts and complete installers require platform QA, not enforced yet |
| Other platform runtime behavior | Not enforced by tests on the current host |
