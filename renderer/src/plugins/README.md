# Local renderer plugins

Link a local plugin directory here. Each directory exports a default
`KrobiPlugin` from `plugin.tsx`; no plugins are required for a public build.
Directories and symlinks are ignored by Git. The registry discovers them in
sorted order, adds their translations without replacing host keys, and exposes
pages, detail routes, Addons cards, settings sections and track menu items.
See `docs/PLUGINS.md` for the optional `complemento` card contract.

Use unique page, route and settings identifiers. Lazy-load screens, and wrap
lazy settings in a Suspense boundary. The eager entry point must not import
host modules that consume this registry (App, layout, BrowseRouter,
SettingsModal, or track menu hosts); shared components, navigationStore,
`data/`, i18n and context/utilities are available. Plugins own their API
schema and typed wrappers over `performRequest`.

Vite, Vitest and TypeScript preserve symlink paths so host imports resolve
relative to this directory. Public translation extraction excludes plugins;
maintain translations in the plugin repository.

Lazy feature modules use `renderer/src/plugins/host.ts` for the settings
context/page, data API and test-helper exports. Keep that barrel out of the
eager entry point because SettingsPage consumes the registry. The old context,
page, data and test-helper paths remain deprecated re-export shims until after
v0.2; migrate imports without changing section ids or persisted values.
