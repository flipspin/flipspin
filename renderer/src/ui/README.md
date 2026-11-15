# krobi-ui

Flipspin's own UI kit, derived from the author's own design system. It is
maintained in this repository under AGPL-3.0 (or later), like Flipspin; see the
root [LICENSE](../../../LICENSE).

This is the subset Flipspin uses: scoped tokens, CSS primitives, and Button,
Input, Field (with FieldContext and Label), Card and FileInput, plus their
small helper modules. Add or change pieces here alongside their consumers.

Load `tokens/base.css`, then `tokens/personal.css` or `tokens/glass.css`, then
`primitives.css` and, for the React controls, `react/styles/components.css`.
Tokens live on `.krobi-setup` / `.krobi-settings`, never `:root`. The `personal`
profile supplies setup surfaces and its `krobi` variant supplies Settings;
`glass` supplies the wizard and sign-in. Settings maps its colours to the app's
active palette and mode in `renderer/src/settings/settings.css`.

The account deletion dialog loads `tokens/modern.css` and
`modern-primitives.css`. Its `modern` profile and `calm` tone live only on
`.krobi-modern`; `renderer/src/settings/delete-account.css` maps its colours to the app.

The existing `.z-` / `.zr-` class names, custom properties and profile values
are stable implementation details, retained to preserve the appearance. Only
classes referenced by Flipspin or emitted by these components are included;
component variants and conditional/error states remain supported. Keep token
dependencies and the wizard's dynamic accent hues when trimming styles.

Run `node scripts/verify-krobi-ui.mjs before` before a change, then
`node scripts/verify-krobi-ui.mjs after`. The Chromium driver uses the HTTP
fixtures and navigation from the other `scripts/verify-*.mjs` drivers. It saves
1440×900 welcome, Settings → Resumen, Configuración and sign-in screenshots in
the driver’s default evidence directory, and compares PNG bytes and rendered computed
styles. Also run typecheck, the complete test suite, lint and build:frontend.
