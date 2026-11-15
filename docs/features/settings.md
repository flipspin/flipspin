# settings — Settings as a page: this computer, my account, and the nest's admin

This page describes desktop Settings; phone clients keep their own layouts.

## What it does

Settings is a **page in the main content area**, with the existing app header,
sidebar and player around it. It opens on "Overview" unless a section was
requested. Navigation keeps playback running. The sidebar, header menu and
`openSettings(section)` share `krobi-show-settings`; `krobi:open-settings` is
also accepted. Legacy section ids still resolve in `renderer/src/settings/sections.ts`.
There is no settings modal, close button or page-level Escape handler; the
section dialogs retain their own focus and dismissal behavior.

At ≤899 px, Overview is the index and sections stack with a back button.
Add-ons is the top-level door to Lyrics, Stems and optional plugin cards.
Groups: **This computer** (General) · **Your account** (My account) · **Nest**
(Library, Sources, Remote access, Accounts) · **System** (Status, Helpers,
Logs, Advanced). Lyrics and Stems keep Add-ons selected; Analysis is
reached through Library. The old `extensiones` and plugin-id shortcuts open
Add-ons; a plugin's card opens its existing settings. See `docs/PLUGINS.md`. The original section menu keeps its hue tiles, current
item, badges and state/version/disk foot. Admin-only sections stay gated.

Groups use ink-edged cards with a thick section-hue top bar and hard shadow,
a capped 720 px content column, and divided label/value rows with actions at
the right. Overview retains its nest card, Pending card and flat index.
Remote access retains the shared RemoteSetup and AddressList screen/graphics.
Accounts unfolds into device/name/password/type/delete rows, with its existing
dialogs; device counts stay unknown until the existing lazy query completes.
Stems (`stems`, admin) opens from its Add-ons card; Lyrics no longer lists
the "Split into stems" job row.

## Decisions

| question | answer |
|---|---|
| container | main-content page |
| landing | "Overview" |
| Import | stays under "Library" |
| Shortcuts | its own block in "This computer" |
| update row | preserve version/release checks, installation/command, skip and retry controls |
| disk use | the whole data disk, split music · stems · the rest |
| VLC | asked in "Send to → VLC" where it is used; "This computer" keeps a "VLC" row (address · "Swap" · "Remove") editing the same value |
| phone push | Android FTP and the QR share are gone; VLC upload stays |

## Server

| route | who | answer |
|---|---|---|
| `GET /api/server/storage` | admin | `{disk: {total, free}, music, stems, other}` in bytes for the data disk (`shutil.disk_usage` on the data dir; `music` and `stems` summed and cached ~5 min, `other` = used − music − stems) |

The existing routes and response contracts are unchanged.

## States

Every section draws loading (skeletons shaped like the content), error with
"Retry", empty with its next action, and "older nest" (a route a server
does not have yet: a muted version note, never an error). Switches act at once
and offer "undo"; a failed save says why in place.

## Renderer verification

`npm test` includes a Chromium computed-style regression over every offered
palette × mode, with both light and dark OS preferences. Install its browser
once with `npx playwright install chromium` (CI installs it with dependencies).
The bridge in `renderer/src/settings/settings.css` overrides the UI kit colour tokens;
krobi-ui supplies the shared controls; the page supplies the approved groups and rows.
`node scripts/verify-settings-page.mjs` compiles the real renderer with fake HTTP
and native boundaries, captures all sections and verifies uninterrupted playback. The verifier also supports a synthetic plugin registry for checking cards and
light/dark captures at 1440 and 402 px.

## Copy

The code owns content and copy; the Settings reference owns layout and style.
Canvas example data and invented rows are not product features. English source
copy goes in `t()`; add the English and Spanish catalog lines by hand.
No explainer lines: details live in tooltips. "Flipspin" in prose; banned words in
`contracts/one-account.json`.

## Not in scope

The phones' Settings. An in-app updater. Moving Import
to Browse.

## Status → "Computer"

From an approved mock. "Dónde corre"
leaves "Version" for a new block, **Equipo**, that says what machine the nest is,
so "Another computer on the network" stops being the whole answer. Admin-only (it is a map of
the deployment), desktop; the phones do not show it.

`GET /api/server/host` — owner (`require_owner`), never public:

```json
{ "hostname": "krobi",
  "os": { "name": "Debian GNU/Linux", "version": "12" }, "kernel": "7.0.14-12-pve", "arch": "x86_64",
  "isolation": "lxc" | "docker" | "vm" | "none" | null, "hypervisor": "proxmox" | null,
  "cpu": { "model": "Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz", "cores": 4 },
  "memory": { "total": 4294967296, "used": 122683392 },
  "python": "3.12.16", "bootedAt": "2026-10-07T…Z", "startedAt": "2026-10-28T06:05:23Z",
  "engine": "local" | "agent" }
```

Every field may be `null` when the platform does not say (a field that cannot be
read is `null`, never an error; the route never 500s for one missing fact). `engine`
is `LyricsService.engine_mode`. `isolation: "none"` means the platform confirmed no
isolation; `null` means detection failed.

| block | row | value |
|---|---|---|
| Versión | Versión · Dirección · ID (admin) | as before |
| Versión | Encendido | "hace 9 min" from `startedAt` (same words as remote-access `ago`) |
| Equipo | Dónde corre | "This computer" / "Another computer on the network" / "Este servidor" (as before) · `hostname` in mono |
| Equipo | System | "Debian 12 · Linux 7.0 · x86_64" (`os.name` short form, `os.version`, kernel major.minor, `arch`) |
| Equipo | Aislamiento | "Contenedor LXC · Proxmox" · "Docker container" · "Virtual machine" · "None" |
| Equipo | Procesador | CPU model without vendor noise ("Intel Core i7-8750H") · "4 núcleos" |
| Equipo | Memoria | "0.1 de 4 GB" + a meter |
| Equipo | Python | `python` |
| Equipo | Equipo encendido | "hace 3 semanas" from `bootedAt` |
| Equipo | Lyrics y stems | `engine == "agent"`: info dot · "En una Mac con Apple Silicon" · muted "this computer is x86"; `local`: "On this computer" |

A field that is `null` shows "—" with the reason in a tooltip. Loading: skeleton
rows; error: the block's "Retry". Members never request it.
