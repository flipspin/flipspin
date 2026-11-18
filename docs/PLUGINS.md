# Local plugins

Flipspin supports optional backend, renderer and worker extensions. A clean clone
has no plugins. Install only trusted code: these hooks run with the host's
permissions, not in a sandbox.

## Backend

`KROBI_PLUGINS_DIR` defaults to `plugins/` beside the configured playlists
directory. Each child package must have a valid Python identifier as its name.
Its manifest names the module exporting `register(context)`; the legacy default
is `krobi_plugin.py`:

```python
from fastapi import APIRouter

def register(context):
    router = APIRouter(prefix="/api/example")

    @router.get("/status")
    def status():
        return {"ready": True}

    context.include_router(router)
```

`PluginContext` supplies the app, dependency container, configuration and logger.
Register routers through `context.include_router`; the loader attaches the
same authentication dependency as the host. Apply owner authorization to
privileged endpoints and declare response models for client-facing routes.
Registration is staged: a failing plugin is logged and its routes are not
installed. `/api/status` lists successfully loaded package names in `plugins`.
Restart the backend after changing the plugin set.

Keep plugin settings and generated API schemas in the plugin repository.
Host tests isolate `KROBI_PLUGINS_DIR`, so the committed host schema describes
only the public API. Preserve existing data paths when extracting a feature.

### Import only from `app.plugin_api`

Backend plugins import host names from `app.plugin_api`. It is the stable
surface: names may be added freely; a removed or renamed name keeps an alias
for one release. Existing host module imports continue to work.

The exports are:

- Wiring and configuration: `PluginContext`, `DependencyContainer`,
  `ConfigManager`, `APP_VERSION`, `LoggerConfig`, `get_config`.
- Identity and authorization: `Principal`, `current_principal`, `require_owner`,
  `require_local_client`.
- Library access: `LibraryScope`, `get_library_scope`, `get_user_track_store`,
  `link_acquired`, `rel_path_for`, `resolve_track`, `resolve_under`,
  `safe_open_path`, `file_signature`.
- Metadata and shared models: `AcquireTrack`, `AgentIdentity`, `BrowseTrack`,
  `Confidence`, `ExportedTrack`, `ResolutionService`, `normalize_key`,
  `normalize_loose`, `artist_credit_text`, `DEFAULT_CONTACT`,
  `RECORDING_LOOKUP_INC`, `WORK_LOOKUP_INC`.
- Errors and file helpers: `AudioEditorError`, `BurningError`, `ExternalAPIError`,
  `MusicNotFoundError`, `ValidationError`, `unexpected_errors_as_500`,
  `write_secret_lines`.
- Helper job kinds: `JobKind`, `register_job_kind`. The latter is the host's
  `Kinds.register` function: call `register_job_kind(queue.kinds, kind)` on the
  shared host queue during registration. It creates no separate registry.

Use the supplied `PluginContext` for app access. Concrete provider and storage
implementations are outside this surface.

## Renderer

Link a plugin directory under `renderer/src/plugins/<name>` with a default
export in `plugin.tsx`. The `KrobiPlugin` contract in `types.ts` supports pages,
browse routes, settings sections, a Plugins card, track-menu items and
translation bundles.
An optional `Provider` wraps the application below the host contexts, so plugin
state and playback can survive navigation. Providers must clean up their own
audio nodes and listeners when unmounted. Keep provider imports lightweight;
feature pages still load lazily.
These local directories are gitignored; the generic registry remains tracked.

Use lazy page components. Do not import host wiring modules such as `App`,
`BrowseRouter`, sidebar/header, settings-modal or context-menu hosts: those
import the registry and would create cycles. Use the shared data transport,
bridge and UI components instead. Keep API types and translations plugin-owned.

### Stable renderer host imports

Lazy plugin feature modules import host values from
`renderer/src/plugins/host.ts` (for a file at the plugin directory root,
`../host`). It exports the settings context/provider and types, `SettingsPage`
and its props, the data-layer public API, and the fake-settings test helpers.
For example, a lazily loaded settings screen can import `useSettings` and
`performRequest` from that module. Tests can import `installFakeSettings`,
`serverStatus`, `RecordedRequest` and `ResponseSpec` from the same entry.

Keep this barrel out of eager plugin entry points: the settings page consumes
the registry. Load feature modules lazily and keep test helpers in test imports.
The old context/page names remain aliases: `useAjustes`, `AjustesProvider`,
`AjustesContextValue`, `AjustesHost`, `AjustesPage` and `AjustesPageProps`.
The `PluginComplemento`, `PluginComplementoState`, `PluginComplementoAction`
and `PluginComplementoRow` types remain aliases of their `PluginAddon` names.

These paths remain re-export shims for one release:

- `renderer/src/app/components/browse/BrowseStates.tsx`
- `renderer/src/app/components/browse/navigationStore.ts`
- `renderer/src/app/components/browse/useAcquisition.ts`
- `renderer/src/app/components/lyrics/lyricsStore.ts`
- `renderer/src/app/components/lyrics/macEngine.ts`
- `renderer/src/app/components/settings/SettingsSection.tsx`
- `renderer/src/app/components/settings/SettingsSwitchRow.tsx`
- `renderer/src/app/components/shared/CoverTile.tsx`
- `renderer/src/app/components/shared/Select.tsx`
- `renderer/src/next/ajustes/AjustesPage.tsx`
- `renderer/src/next/ajustes/context.tsx`
- `renderer/src/next/data/index.ts`
- `renderer/src/next/data/test-support.ts`
- `renderer/src/next/settings/testSupport.ts`
- `renderer/src/lib/identityStore.ts`
- `renderer/src/lib/userLibraryStore.ts`

Each carries the marker “Deprecated path kept for plugins; remove after v0.2.”
New host implementations live under settings and the typed data layer; plugin
consumers can migrate without changing their data or navigation contracts.
Settings section ids, hash routes, localStorage keys, IPC channel names and
translation keys keep their established values. English section spellings
remain accepted aliases of the original ids. The emitted settings hash stays
#/ajustes, and #/settings remains an accepted alias.

### Plugins card

`complemento?: PluginComplemento` contributes one card to Settings → Plugins,
in registry order. The host uses the same card header and two rows for
built-ins and plugins. No plugin is needed: a clean host shows only the Ties
and Recommendations "Coming soon" cards.

```tsx
const plugin: KrobiPlugin = {
  id: 'example',
  settingsSections: [{ id: 'example-settings', label: 'Ejemplo', icon: Puzzle,
    color: 'purple', Component: lazy(() => import('./Settings')) }],
  complemento: {
    id: 'example', name: 'Ejemplo', icon: Puzzle, kind: 'Extensión',
    description: 'Descripción del complemento',
    nido: { value: 'Información del nido', state: { label: 'Activo', tone: 'ok' } },
    computer: {
      value: 'Información de este equipo',
      state: { label: 'Sin instalar', tone: 'off', title: 'Detalle del estado' },
      install: { run: () => { /* plugin-owned installation */ }, disabled: false },
      // remove: { run: removeLocalFiles, disabled: false, title: 'Qué se quita' },
    },
    open: { kind: 'settings', id: 'example-settings' },
  },
}
```

Each row supplies `value` and `state { label, tone, title? }`; tones are `ok`,
`warn`, `bad`, and `off`. `computer.install` and `computer.remove` are optional
`{ run, disabled?, title? }` actions, labelled "Install" and "Remove" by the
host. Callbacks own their work, progress, refresh and error handling; the host
does not infer installation state or call a backend on a plugin's behalf.
Names, descriptions, values, state labels and tooltips are translation keys in
the plugin's own `locales` bundles (include Spanish and English). Host source
keys are now English, such as `t('Save')`; add identity English and Spanish
translation lines by hand in both host catalogs, without `i18n:extract`.
Existing plugins keep their own Spanish keys and namespaces unchanged. The host
registers empty plugin values as identity strings so English fallback does not
replace Spanish plugin copy. Host legacy aliases apply only to unresolved host
keys; a plugin's own resources take precedence. Use globally
unique card, page and settings ids; the referenced page/section must be registered.

`open: { kind: 'settings', id }` makes "Open" expand that existing settings
component inside the card, under a Suspense boundary; "Close" collapses it.
If the plugin also has a page with that settings id, "Go" inside the opened
card preserves access to that page. `open: { kind: 'page', id }` instead opens
the plugin's registered app page through the host's `openPage` callback.
A missing target or unavailable host callback disables "Open".

The previous extension settings were owner-only; cards preserve that boundary:
settings, pages and local actions are unavailable while role loads or to members.
Settings sections without a card targeting them receive compatibility cards,
with unknown values/states shown as "—" and no installation actions. This keeps
older plugins' settings reachable and also preserves settings when a plugin
chooses a page as its explicit card target. New plugins should target their
settings from their card when they contribute settings.

For live counts or installation state, supply an optional `useRows(enabled)`
hook returning `{ nido, computer }`. It runs inside the mounted card and can
subscribe to plugin stores or queries. Fetch only when `enabled` is true (the
owner boundary); clean up subscriptions on unmount. Static rows remain the
fallback for plugins without a hook. A row's optional `values` object supplies
translation interpolation, for example `{ value: '{{n}} songs', values: { n: 12 },
state: { label: 'Active', tone: 'ok' } }`. Keep the keys in both locale bundles.

There is no Settings → Extensiones screen. `openSettings('extensiones')` and
legacy plugin ids land on Plugins; the person opens settings from the
plugin card's "Open". The Overview index includes contributed card names.

Vite, Vitest and TypeScript preserve symlinks so plugins resolve the host's
React and shared modules. Link or unlink before starting Vite or building.
Verify both a clean host build and a linked build before shipping an extension.

## Worker

Install a Python package with an entry point in `krobi_helper.plugins`. Its
module exports `register(registry)` and can add CLI commands, capability checks,
prefetch hooks and agent claim steps. Agent steps run after lyrics and stems;
a step returning true consumes that turn. Registration must be lightweight:
defer model imports until execution.

Both installers install the base worker wheel together with additional wheels
in the bundle's `helper-worker/` directory. Development installs can specify
extra package paths through `KROBI_LYRICS_PLUGIN_SOURCES`, separated by the
platform path separator. Reinstall the worker after changing installed plugins.
Build tooling refreshes the base wheel without deleting additional plugin wheels.

Public release builds must come from a clean checkout with no private links or
extra staged wheels. Unlinking source does not remove an already built private
bundle; rebuild before distribution.

The former `krobi_lyrics.plugins` entry-point group is also scanned for one
release. The bundled `krobi-lyrics` compatibility distribution forwards old
`krobi_lyrics` imports to `krobi_helper`; existing plugin dependency declarations
continue to resolve. A name registered in both groups loads once, preferring
the new group. Plugin wheels staged in `backend/lyrics-worker/` by older build
scripts are still discovered alongside those in `backend/helper-worker/`.

Host sources use `@state/*` → `renderer/src/state/` and `@lib/*` →
`renderer/src/lib/`. The `@context/*` and `@utils/*` aliases remain equivalent
plugin spellings through v0.2. All three resolvers (TypeScript, Vite and Vitest)
also map `@wasm-audio-decoders/opus-ml` to the unchanged engine stub.

The stable host barrel also exports browse navigation (`push`, `currentRoute`,
`reset`), lyrics helpers (`lyricsKeyOf`, `refreshMac`, `useMacEngine`), the default
i18n instance (also named `i18n`) and `msg`, all plugin contract types, and the
plugin registries (`pluginComplementos`, `pluginPages`, `pluginRoutes`,
`pluginSettingsSections`, `pluginTrackMenuItems`). Shared controls, browse
states/actions and data test helpers are exposed there as well. Data helper
`RecordedRequest` and `ResponseSpec` types use the names `BackendRecordedRequest`
and `BackendResponseSpec` to avoid collisions with settings test helpers.

## One extension manifest

New packages include `krobi-extension.json`. The same format describes Engines
(`kind: engine`), Sources (`kind: source`) and Plugins (`kind: feature`). IDs
are unique across all three kinds and match `[a-z0-9][a-z0-9-]{1,40}`.
All fields below are required; unknown fields are ignored for forward compatibility.
`version` is the extension's semantic version, independent of its protocol versions.

```json
{
  "manifest": 1,
  "id": "example",
  "kind": "feature",
  "name": "Example",
  "version": "1.0.0",
  "protocol": {"plugin_api": [1]},
  "runs": ["nest", "desktop"],
  "adds": ["page", "settings-section"],
  "reaches": [],
  "entry": {"module": "example.krobi_plugin"},
  "license": "AGPL-3.0-or-later",
  "homepage": "https://example.test"
}
```

`reaches` declares network hosts contacted by the extension; an empty array
means none. It is metadata, not a network sandbox. `adds` describes contributions
such as `source:audio`, `page`, `menu-action`, `settings-section` or `engine:lyrics`.

| Kind | Protocol key | Runs | Required entry |
|---|---|---|---|
| engine | `helper` | `helper`, `nest` | `{"extra":"engine"}` (Lyrics), `stems` or `analysis` |
| source | `source` | `nest` | `{"command":["{python}","-m","example_source"]}` |
| feature | `plugin_api` | `nest`, `desktop` | `{"module":"example.krobi_plugin"}` |

The host currently accepts `helper: [1]`, `source: [1]` and `plugin_api: [1]`.
The declared list must overlap the accepted list for the extension's kind.
The backend checks this **before importing any package code**; the helper checks
before loading its entry point. Refused packages cannot register routes or hooks.
A backend module must belong to its installed child package and declare `nest`
in `runs`. The module exports the existing `register(context)` API.

The owner-only `GET /api/extensions` returns `{extensions: [...], accepted: {...}}`.
Each observation contains `id`, `kind`, `name`, `version`, `protocol`, `runs`,
`adds`, `reaches`, `entry`, `license`, `homepage`, `state` and nullable `reason`.
Unreadable/invalid manifests retain a directory identity; unavailable metadata
is null or empty. The states are:

- `on`: compatible and registered, or available for the source registry.
- `off`: disabled or unavailable. Built-in engine observations describe readiness
  in the nest; the existing computer row still describes that device's installation.
- `restart-pending`: a host change awaits restart.
- `failed:<kind>`: failure such as `failed:registration` or `failed:installation`.
- `incompatible`: no overlapping protocol; nothing is loaded or spawned.
- `invalid`: malformed JSON, a missing/invalid required field, wrong kind/runtime,
  or a duplicate identity.

Settings → Plugins and Engines use these observations for versions and state
words, with `reason` in the state tooltip. Existing local install controls remain
on the computer row. Older servers without the endpoint retain their existing rows.

### Sources and built-in engines

Sources are discovered from `<data>/sources/<id>/krobi-extension.json`. No
source is bundled with the host. The acquisition
registry calls `app.infra.extensions.source_extensions(data_dir, builtin_dir=None)`;
it returns typed observations, including refused manifests, without importing or
spawning sources. It may spawn only a source with `state == "on"`.
`{python}` in `entry.command` is replaced by the interpreter of that source's venv
by the source host. An empty source list is valid.

Lyrics, Stems and Analysis ship manifests under `backend/app/infra/engines/`.
They declare `runs: ["helper", "nest"]` and extras `engine`, `stems`, `analysis`
respectively. The Lyrics extra is named `engine` in the helper distribution.

### One-release legacy path

Backend packages without a manifest continue loading `krobi_plugin.py` for one
release, with a warning identifying them as legacy. They report `state: "on"`
and a legacy reason (or `failed:registration` on failure); their version and
other undeclared metadata are unknown. Adding an invalid manifest opts out of
this fallback: it is refused rather than treated as legacy.

Helper entry-point wheels may also omit the manifest for this release, with the
same warning. New helper engine extensions place it in the entry-point package tree
(or at the distribution root) and include it in the wheel's file list. It must
be `kind: engine`, run in `helper`, and accept a helper protocol. The entry point
still supplies `register(registry)`; `entry.extra` describes its install extra.
The helper reads distribution files before importing the module. Ambiguous,
unreadable, invalid and incompatible manifests are refused. The previous
`krobi_lyrics.plugins` entry-point group remains supported as described above.

## Source plugins

No audio source ships with Flipspin. An owner chooses **Add a plugin → Add** in
Settings → Plugins, enters an HTTPS Git URL, an SSH Git location (`git@…`), or
an existing directory on the nest, and chooses **Install**. The sheet shows the
durable job's progress and any failure reason. Installed rows show the manifest's
name, version and observed state; **Update** installs again from the recorded
location. **Remove** confirms, stops the source and deletes its files and data.
Provider order retains the removed id so reinstalling restores its position.
There is no automatic code installation on upgrade.

Each installed source lives in `<data>/sources/<id>/`:

```text
krobi-extension.json   validated copy of the source manifest
install.json           location, kind (git/path), commit?, version, installedAt
src/                   fetched package
venv/                  source's Python environment
data/                  private persistent source data
```

A `https://github.com/<owner>/<repo>` address is fetched over HTTPS with no git:
the server reads the default branch's commit and extracts that commit's archive,
dropping links and refusing paths outside it. Other repository addresses use
`git clone --depth 1` and need git on the nest. A local folder is copied without
following symlinks, excluding `.git`, `.venv` and `__pycache__`. It validates the
manifest's source kind and protocol, creates a Python environment, installs the
package with pip, and calls `hello` and `test` with deadlines. Only then does it
replace the installed tree. Updates preserve `data/`. A failed build, handshake
or test leaves installed sources unchanged and removes staging.
The failed job's item detail carries `step` (`download`, `unpack`, `verify`,
`build`, `test`, `publish`) and `cause`, a code a client translates; both lists
are in `contracts/source-plugin.json`. A transaction
journal recovers an interrupted replacement before sources are discovered.

A desktop nest passes its bundled uv as `KROBI_UV`; uv creates a Python 3.12
venv. An ordinary Python nest uses its interpreter's `venv` module. A frozen
nest without uv reports “This nest can't build plugins”. Containers include git.
Git credentials, when required, must already be available to the nest; git never
prompts for them.

A plugin is code the owner chose to run, with the nest's access. The subprocess
boundary isolates dependencies and failures; it is not an operating-system
sandbox. Manifests describe access rather than restricting it. Only an owner can
install, update, remove or invoke actions. Cookies remain in the host and reach
search/fetch as `options.cookiesFile`; they are never command-line arguments.

### Source protocol 1

A source's manifest declares `kind: "source"`, `runs: ["nest"]`,
`protocol: {"source": [1]}`, `adds: ["source:audio"]` and an `entry.command`.
The host replaces `{python}` with that source's `venv/bin/python` (Windows:
`venv/Scripts/python.exe`). Every request is a JSON line with an opaque `id`,
`method`, and `params`, including a positive relative `deadline` in milliseconds.
Stdout carries protocol messages only; stderr carries logs. Requests may
interleave and replies correlate by `id`.

```json
{"id":"call-1","method":"hello","params":{"protocol":[1],"deadline":5000}}
{"id":"call-1","result":{"id":"example-source","version":"1.0.0","protocol":1,"kinds":["audio"],"urlHosts":["example.test"]}}
```

| Method | Params beyond deadline | Result |
|---|---|---|
| `hello` | `protocol: [1]` | matching `id`, `version`, `protocol: 1`, `kinds: ["audio"]`; optional `urlHosts` |
| `test` | none | `ok: true` |
| `search` | `wanted: {title, artist, album?, duration?, isrc?}`, `limit`, `options?` | `rows: [{id, title, artist, duration, url, flags: []}]` |
| `fetch` | `id`, `dir`, `format: "m4a-copy"`, `options?` | `path`, `bytes`, `duration`, `codec`, `bitrateKbps`, `transcoded` |
| `status` | none | optional `revision`, `facts`, `actions`, `toggles`, `warning` |
| `action` | `id`, optional `value` | fresh status |

Durations are seconds. A terminal reply has either `result` or
`error: {kind, message, retryAfter?, details?}`. Kinds are `not-found`,
`auth-required`, `rate-limited`, `blocked`, `network`, `broken`, and `bug`;
`retryAfter` is seconds. Fetch progress uses correlated
`{"id":"call-2","progress":{"pct":47.5}}` lines at most once per 250 ms.
Crashes, invalid responses and deadline expiry kill the child process group and
fail pending calls. The next call respawns with bounded backoff.

The v1 additions are optional. Old plugins answer unknown methods with a typed
error; unsupported status supplies no facts and does not change source health.
Unknown result keys are ignored. `hello.urlHosts` lists exact hosts accepted for
direct URL fetch. Enabled sources' hosts plus `KROBI_DOWNLOADER_ALLOWED_HOSTS`
form the host's URL validation policy. The host gives each process
`KROBI_SOURCE_ID` and `KROBI_SOURCE_DATA`; the latter names its persistent `data/`
directory and survives updates until Remove.

```json
{
  "revision": "tool-2",
  "facts": [{"label": "Tool", "value": "2", "tip": "Verified"}],
  "actions": [{"id": "update", "label": "Update now"}],
  "toggles": [{"id": "auto-update", "label": "Update automatically", "value": true}],
  "warning": "Tool needs attention"
}
```

The host caches status for Settings and refreshes enabled sources hourly. Labels
are the plugin's English copy. A changed opaque revision retries only that
source's `broken`/`blocked` acquisition items from the previous revision window;
retry intent survives a restart. Actions have a 120,000 ms deadline. Plugins own
their tool updates and may repair themselves after a blocked or broken fetch.

Owner HTTP routes are `POST /api/sources/install {location}` (immediate
`progress_id`), `POST /api/sources/{id}/update`, `DELETE /api/sources/{id}`, and
`POST /api/sources/{id}/action {id, value?}`. Sources join or leave the provider
registry without restarting the nest. `GET /api/extensions` reports manifest and
runtime state. Legacy cookie routes and environment names remain aliases.

If a legacy enabled source is missing, Overview offers an installation to-do.
`KROBI_SOURCE_LOCATION_YOUTUBE` is an editable text setting, empty by default,
used only to prefill its location. An empty value leaves the field empty.
