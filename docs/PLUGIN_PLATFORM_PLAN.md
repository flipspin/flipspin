# Public Plugin Platform Plan

Status: proposed implementation plan, 2026-10-16. This document describes future work; the current supported behavior remains in [PLUGINS.md](PLUGINS.md).

Flipspin will expose a public, versioned plugin framework for optional providers, pages, track actions, and worker jobs. The framework, SDK, developer tools, documentation, and a small example plugin belong in the open-source repository. Experimental plugins remain separate consumers of that API. Core refactors should not require plugin changes unless a supported contract changes.

## Release scope

| Milestone | Delivered behavior | Release boundary |
| --- | --- | --- |
| A — Developer preview | Manifest validation, management UI, stable SDK preview, deferred activation, diagnostics, local source linking | Trusted developer extensions; renderer additions still require a host build. No install button implying otherwise. |
| B — Installable trusted plugins | Versioned packages, staged installation, compatibility checks, process supervision, runtime UI loading, update and rollback | Owner-installed trusted native code. No marketplace or claim that Python is sandboxed. Runtime custom UI must pass the isolation gate below. |
| C — Restricted third-party execution | Enforced runtime capabilities and platform-specific containment for supported plugin classes | Separate security design and validation. Manifest declarations alone do not provide isolation. |

Milestone A is independently useful but does not complete the installable-plugin objective. Milestone B is complete for full-feature plugins only when a page, backend component, and Mac worker can be added to an already-built app without rebuilding Flipspin. If custom UI isolation proves infeasible on a target platform, ship a clearly limited provider-only runtime there and leave the full-feature milestone open.

Do not add a marketplace, dependency marketplace resolver, arbitrary installation scripts, hot Python unloading, or a WASM rewrite of the ML pipeline to these milestones.

## Current constraints

- `renderer/src/plugins/index.ts` eagerly imports plugin entries. Routes can collide, and translations share the host namespace. Feature screens can be lazy, but discovery is build-time.
- The accompanying Settings redesign mounts panes on first visit and retains visited panes to preserve drafts. Those visited panes can still run effects while hidden; the plugin lifecycle must add explicit suspension/disposal. Lazy imports alone do not provide that behavior.
- `backend/app/plugins.py` imports trusted Python and calls registration during application import. Registration rollback cannot undo arbitrary imports, threads, or process-wide side effects.
- The backend context exposes the app, container, and configuration. These are legacy implementation access, not a stable public API.
- Worker extensions share the base worker environment and cached registration. Updating a plugin can affect unrelated dependency versions.
- Tauri currently has no CSP configured, and `build.rs` does not explicitly scope application commands. Runtime plugin UI requires additional controls.
- The host has unrelated in-progress changes. Implementation must use explicit file ownership and selective staging; preserve those changes.

## Product experience

Add one **Settings → Plugins** section. Plugin configuration lives inside its detail view instead of adding one top-level settings section per plugin. Reuse host spacing, switches, buttons, status treatments, and navigation patterns.

The list shows name, author, installed version, enabled state, and a short actionable status. Details show source, compatibility, required access, component readiness, configuration, diagnostics, and supported maintenance actions. Do not show a reassuring permission checklist for trusted native code: disclose that it runs with the corresponding host account's privileges.

Keep installation state, desired enablement, runtime activity, and readiness distinct. An enabled plugin may be idle; a plugin with an offline Mac may still provide server-only features. Render useful labels such as **Done**, **Desactivado**, **Preparación pendiente**, **Mac desconectado**, **Incompatible**, and **Error** from structured reason codes.

For a multi-component plugin, group readiness under **Nest**, **Esta app**, and **Procesamiento**, using the configured server and worker device names. A missing model should offer **Preparar modelos** with progress, cancellation, disk requirements, and retry. Remote clients must not offer installation actions on the server host. Readiness is capability-specific: previously computed results can remain available while the embedding worker is offline. Background work can report **Queued · esperando a la Mac** without making the entire plugin look broken.

### User flows

1. Developer preview: link a local plugin with tooling, validate its manifest, rebuild the renderer if required, and display it as a development extension. Missing components have explicit setup instructions.
2. Package installation: owner selects a package; host validates it without executing it; review shows provenance, version, targets, compatibility, and trust implications; install stages components; activation occurs only after checks pass. Model downloads are a separate visible operation.
3. Disable: stop new plugin requests/jobs and remove its active UI contributions. Show running work as stopping or draining. If imported legacy Python remains resident, show **Reinicio pendiente** rather than claiming it unloaded.
4. Update: stage the new version while the old version stays usable; validate and health-check; switch atomically per target; retain the last healthy version. Show pending or mixed target versions until reconciliation finishes.
5. Remove: stop work and remove code, preserving settings and user data by default. Deleting plugin data is a separate explicit destructive action. Explain when shared model files cannot be removed exclusively for this plugin.

Owners manage server installation, enablement, and configuration. Members see only usable contributions and relevant readiness; they cannot inspect private paths, secrets, or administration logs. Local native installation also requires local authority; server ownership does not silently authorize execution on every desktop. Personal page pinning is separate from global enablement.

Page contributions are available from the plugin manager and optional user-pinned navigation. Providers do not get a sidebar page by default. Track actions use synchronous declarative applicability checks; network calls occur only after invocation. Preserve existing private-plugin entry points through migration aliases and migrate existing pin preferences once. Disabling the current page returns to a stable host view; stale links show a host-owned recovery screen. Do not modify `PortraitTabBar.tsx` in this work.

All new UI is typed and uses English source keys with Spanish translations, added by hand to both catalogs; `i18n:extract` remains unused. Include keyboard navigation, focus restoration after removal/dialog closure, accessible status announcements, non-color status cues, reduced-motion behavior, and narrow-screen layouts. When changing Settings integration, implement arrow-key/Home/End behavior for its tab list. Hidden plugin panels must suspend work; preserve unfinished forms in host-owned draft state instead of mounting every plugin.

## Shared contracts

Freeze these contracts before parallel implementation. Keep a machine-readable JSON Schema and matching Python/TypeScript fixtures under a public `plugin-sdk/` directory. Version the plugin API separately from the application release.

### Manifest

Use `krobi-plugin.json` with `manifestVersion`, globally namespaced `id`, `name`, `version`, `publisher`, `license`, `homepage`, `hostApi`, `components`, `contributes`, `activation`, `capabilities`, and `settingsSchema`. Component declarations identify backend, renderer, and worker entry points plus platform/architecture constraints. Artifact inventory records content hashes; publisher identity verification is a separate trust mechanism.

Use namespaced contribution identifiers such as `org.example.notes:track-details`. Reserve host identifiers and reject duplicate plugin IDs, routes, commands, and settings keys deterministically. Paths must stay inside the package; reject unknown manifest versions and incompatible API ranges before importing code. Bound manifest size and contribution counts. Do not permit executable visibility predicates in metadata.

Capabilities describe supported host operations, such as library reads, playback requests, acquisition, plugin storage, or queued jobs. Milestone A uses them for API negotiation and disclosure; it does not pretend to constrain arbitrary Python or source-linked JavaScript.

### State and compatibility

Persist desired state separately from observed state. Each record includes plugin ID, revision, installed version, requested enablement, compatibility, trust/source information, and per-target observations. Each component reports its version, protocol/API version, readiness, reason code, last-seen time, active work, and pending restart. Runtime activation is separate from enablement.

Use revision guards for competing enable/configuration/update requests. Persist state with atomic writes and serialized mutations, following existing host persistence patterns. Keep credentials in the host's secret facility and expose only redacted configuration summaries. Namespace plugin data independently from immutable code versions.

Host API changes are additive within a supported major version. CI exercises the oldest advertised SDK and current SDK. Breaking changes require a new API major, migration guidance, and an explicit deprecation window recorded before release. An unsupported plugin stays installed but cannot activate.

### Manager API

Add typed `/api/plugins` routes with host authentication and explicit owner checks on mutations. Preserve the existing `/api/status.plugins` field for compatibility.

| Route family | Purpose |
| --- | --- |
| `GET /api/plugins` and `GET /api/plugins/{id}` | Sanitized inventory/readiness for authenticated users; administration detail only for owners |
| `PUT /api/plugins/{id}/state` | Desired enablement with expected revision; return observed state and pending actions |
| `GET/PUT /api/plugins/{id}/config` | Schema-validated owner configuration; secrets never returned verbatim |
| `GET /api/plugins/{id}/diagnostics` | Owner-only bounded logs, errors, activation timing, and target health |
| `POST /api/plugins/operations` | Milestone B install/update/remove/rollback commands returning an operation ID |
| `GET /api/plugins/operations/{id}` | Owner-only progress, target results, failure reasons, and retryability; members receive sanitized inventory readiness |

Mount fixed operation routes before dynamic IDs. Use existing progress/event transport where suitable; avoid one permanent polling loop per plugin. Freeze response models and error codes in the contract work package before generating clients. Package validation and mutation failures must leave active code/state intact.

## Runtime and SDK architecture

### Backend and workers

Milestone A discovers JSON metadata before import and skips disabled/incompatible plugins. Keep legacy registration behind an explicit development adapter. Add an enabled-state dependency to legacy plugin routes so disabling blocks new requests immediately. Provide cooperative cleanup hooks; require a restart for residual in-process resources. A Python timeout cannot safely terminate a hung import in the host process, so do not promise failure containment for this legacy tier.

Expose a narrow backend facade for scoped library queries, identity resolution, plugin storage/configuration, logging, progress, and job submission. Public SDK plugins must not receive raw app/container/config objects; only the documented legacy development adapter retains those privileges. Existing experiments migrate behind adapters before the facade is declared stable.

Milestone B supervises plugin backend processes with a versioned RPC handshake, timeouts, bounded payloads, cancellation, and restart backoff. Route requests through a host-owned authenticated gateway under `/api/plugins/{id}/runtime/...`; reserve management paths so plugin endpoints cannot shadow state, configuration, or diagnostics. Forward a scoped principal; do not hand plugins a global bearer token. Processes run under an explicitly documented trust model: crash containment is not OS sandboxing.

Install backend/worker dependencies into versioned plugin environments, never the host environment or shared base lyrics environment. Test environment creation with the frozen desktop backend as well as the ordinary server interpreter. Workers advertise supported plugin/protocol versions; dispatch only compatible jobs. Keep lyrics and stems priority behavior, add bounded plugin concurrency and fair rotation within the plugin tier, and prevent a single broken plugin from spinning or monopolizing claim attempts.

Disable stops new claims and signals cancellation/drain. Terminate supervised work after a documented grace period, release leases retryably, and reject stale-generation results. Backend and Mac cannot be updated atomically together: stage per target, record desired/observed versions, and gate work when protocol versions disagree. An offline Mac stays pending without rolling the server into a false ready state.

Worker discovery reads package metadata without loading entry points. Register executable hooks only after receiving enabled, compatible inventory from the server. Cache the last verified policy for display, but fail closed for new claims when offline or stale. Metadata-only CLI checks remain available without executing plugin code.

### Renderer and native shell

Split discovery, validation, activation, contribution registration, and disposal. Load manifests without evaluating entries. Activate on a declared page, command, event, or explicitly allowed background task. Share in-flight activation promises; attach timeout/error states and a bounded retry path. Error boundaries handle React failures; handler wrappers handle event/promise failures. Neither can rescue an infinite loop in the same JavaScript thread.

Publish a small SDK surface: typed track references, scoped library pagination, player commands, acquisition requests, navigation, scoped API transport, theme/i18n access, settings, job progress, and disposable subscriptions. Pass track references and query services instead of the entire album collection. Export supported UI primitives separately. Ban plugin imports into host internals with lint/build checks. Use a dedicated translation namespace per plugin and never overwrite host strings. Package the pure API and optional React adapters separately; source-local workspace packages are sufficient before publishing an npm SDK.

Milestone A uses source-linked modules with lazy entry imports and host-shared React. Milestone B uses prebuilt assets and a negotiated message protocol. Validate artifact identity and compatibility before loading; do not accept arbitrary remote module URLs or execute bundles discovered from an untrusted server. Treat local client authorization separately from server installation.

The preferred runtime UI boundary is a restricted dedicated webview for desktop deployments using host-mediated RPC. A spike must prove routing, sizing, keyboard/focus behavior, theme/accessibility, asset delivery, authentication, and supported-platform isolation. An isolated UI bundles its own compatible renderer; the host SDK crosses the boundary through data/messages rather than sharing React objects. Declarative contributions remain rendered by Flipspin.

Explicitly restrict Tauri application commands, window/webview creation, event access, asset scopes, and CSP. A plain iframe is not a sufficient cross-platform Tauri boundary: the official docs note that Linux and Android cannot distinguish embedded-frame IPC from the window. Do not fall back to injecting arbitrary package code into the privileged root if the spike fails. [Tauri capabilities](https://v2.tauri.app/security/capabilities/)

The spike must demonstrate denial of host DOM/storage/credential access (including cookies and bearer tokens), direct native IPC, plugin identity spoofing, unauthorized RPC methods, and unsafe navigation/popups/file URLs. Authenticate the RPC channel and validate schemas, sizes, rates, timeouts, and cancellation; revoke it on disable. Explicitly scope native application commands through `AppManifest::commands` before testing denial. Test actual attacks on each supported platform, not just absence of SDK methods or a different origin. Native Python remains trusted even when the UI is isolated; milestone C extends enforcement to native execution.

### Package integrity and recovery

Choose one versioned archive format with a manifest, immutable artifacts, and checksums. Reject traversal, absolute paths, symlink/hardlink escapes, duplicate paths, unsupported executable hooks, and excessive unpacked sizes. Install into a staging directory, verify the complete inventory, and switch the active version only after a health check. Keep installation operations durable and recoverable after process death.

A checksum detects corruption; it does not establish who published a package. Milestone B starts with explicit local package selection and recorded provenance. Any later remote catalog needs publisher authentication, key rotation/revocation, and update trust rules before unattended updates.

Define data migration compatibility before permitting rollback. Code rollback alone is insufficient after an irreversible schema migration: retain a recoverable backup or refuse the update until its recovery path is available. Uninstall must not erase another plugin's storage or shared host data.

## Performance and release gates

Record baseline measurements before setting numerical budgets. Keep measurements reproducible: hardware, build mode, plugin count, warm/cold cache, run count, and distribution of timings. Test Vite development and packaged desktop separately; include a constrained server and Mac worker run.

Deterministic requirements apply immediately:

- A disabled plugin starts no code, timers, requests, model imports, or jobs on cold startup.
- Opening unrelated settings does not load plugin screens or run their effects.
- Track menus require no network round trip and no plugin module activation merely to render labels.
- Hidden/disposed views release subscriptions and preview audio. Plugin removal leaves no retained contribution references.
- Core playback, seeking, and navigation do not wait on plugin activation or model work.
- Bounded queues, payloads, retries, and concurrency prevent unbounded work; cancellation propagates to the actual task.
- A plugin failure produces a local actionable error. Supervised-process failure does not take down the API server.

Benchmark zero plugins, 1 active plugin, 10 disabled plugins, and 10 active lightweight fixtures. Include hung activation, malformed packages, incompatible versions, offline workers, slow endpoints, and repeated enable/disable cycles. Capture startup and activation p50/p95, UI long tasks, request counts, memory after disposal, job latency, and playback interruptions under embedding load. Freeze numeric regression thresholds with the baseline; keep noisy hardware benchmarks separate from deterministic CI gates.

## Work packages and file ownership

Proposed paths below may be introduced during implementation. One integrator owns shared wiring and generated files; other packages supply their intended edits without concurrent writes.

| Package | Owner scope | Dependencies and acceptance |
| --- | --- | --- |
| WP0 Contracts and baseline | `plugin-sdk/schema/`, fixtures and contract declarations, compatibility policy, baseline harness/spec | First. Freeze manifest, state, errors, SDK signatures, and test fixtures. Record current linked/unlinked behavior. Subsequent contract changes go through the integrator. |
| WP1 Backend manager | `backend/app/plugins/` replacement package, plugin manager domain, backend plugin tests | WP0. Metadata-only discovery, owner gates, persistent state, legacy adapter, truthful disable/restart behavior. Preserve `app.plugins` imports during module-to-package move. |
| WP2 Renderer SDK and registry | `renderer/src/plugins/`, SDK implementation/adapters/React exports and tests | WP0. Lazy activation, collision checks, namespaced i18n, scoped SDK, disposal and failures. No edits to frozen contracts or page/menu/settings host wiring. |
| WP3 Plugin manager UX | New typed `renderer/src/plugins/` manager/detail/config components and tests | WP0 models; parallel with WP1/2 using fake backend fixtures. Roles, target readiness, focus, empty/error/progress states. |
| WP4 Worker lifecycle | `helper/` plugin registration, capabilities, scheduling, protocol tests | WP0/1. No heavy imports during discovery; compatibility, disable, cancellation, fairness, stale results. |
| WP5 Runtime and native spike | Prototype package format/loader/process supervisor and isolated UI transport; `src-tauri/` integration proposal | WP0; prototype early, merge after A contracts stabilize. Prove B feasibility in an already-built app and deny native command access from plugin surfaces. |
| WP6 Integration and migration | Host `main.py`/dependencies/system/config wiring, App/sidebar/router/menu/settings wiring, locales, generated schemas, packaging scripts | WP1–4. Integrator alone edits shared files. Migrate private consumer separately; maintain existing URLs and data. |
| WP7 Packaging and release | Final B installer/supervisor from WP5, CI, example plugin, docs, release audit | WP5/6. Recovery/update/rollback, compatible target matrix, no private artifacts, standalone plugin-author workflow. |

With four agent slots, run WP0 with focused reviewer input; then WP1, WP2, and WP3 in parallel while the integrator coordinates. Reuse freed slots for WP4 and the WP5 feasibility spike. Serialize WP6 changes and generated outputs. Finish WP7 after the runtime gates pass.

## Validation and migration

Use backend unit/integration tests for auth, revisions, state recovery, route collisions, package validation, RPC failures, and leases. Use Vitest for lazy imports, disabled-plugin sentinels, settings visibility, role gating, disposal, SDK contracts, and contribution collisions. Test actual packaged Tauri restrictions on supported platforms; jsdom cannot establish a native security boundary.

Run existing backend tests/coverage and Ruff, renderer tests/typecheck/build, Rust tests/Clippy, and worker tests as appropriate. Refresh OpenAPI and generated types only through existing commands. Verify both a clean host and a linked example. Add worker/plugin contract coverage to CI; do not reduce existing coverage floors.

Create one small public example with no network/model dependency. A contributor must be able to create, validate, run, test, and package it using public docs and SDK alone. Keep fixtures/examples outside auto-discovered production directories unless explicitly linked for a test.

Migrate the existing private plugin to the manifest and SDK without moving its feature code into this repository. Preserve API aliases, stored data, identifiers, and pending job semantics. Test one real multi-component plugin privately; public CI must not need private repositories, tokens, model caches, or symlinks.

Build public releases from clean checkouts and inspect emitted renderer chunks, schemas, locales, backend bundles, and worker wheels for accidentally included experimental artifacts. Deleting source links does not clean previously built output. Public history review remains part of the separate open-source release process.

This planning work does not authorize a server restart. Implementation deployment must retain the existing explicit restart approval requirement.

## Design requirements

- Make component access and enabled state visible in the plugin manager. Python plugins do not have WASM isolation; any stronger isolation needs its own runtime boundary.
- Declare execution placement, activation, contributions, and host compatibility explicitly.
- Use explicit manifests, constrained interfaces, and local developer workflows.
- Defer frontend loading and supervise backend processes.
- Expose activation costs so plugin performance can be inspected.

These requirements inform the proposed contracts and gates; performance claims require measurements.
