# Página de lista — a playlist is the album page over a different collection

## What it does

Opening a playlist groups its art, facts, name and verbs in the list's colour
band, then shows its songs (see also `album-page.md`). There is no "List" or
"Playlist" kicker. Above the name, one line reads **● account label · song count
· duration**; the dot uses the list's colour. The owner is the account's `label`
from the users list or the current identity, never its username/device name or
"Yours" / "Another account's". The facts suffix still follows
`contracts/playlist-page.json`. What a list has that an album page does
not — picking several songs — sits beside the whole-list download, not in a
row of buttons of its own. The old playlist header (centred art, two wide
"Play"/"Shuffle" buttons, a "PISTAS ——— n" rule carrying queue /
download / select) is gone.

## Server

None.

## States and controls

| when | the page shows | tapping/clicking it does |
|---|---|---|
| list open | the album page's band (`HeroeColeccion` on iOS, the tablet's `TPaginaAlbum` band on Android, the desktop's `.playlist-hero`) in **the list's colour** — the same accent its grid card's monogram/mosaic uses (keyed on the list's name) | — |
| band, art | the list's mosaic (2×2 covers of its first four distinct albums; one cover if fewer; the monogram if none), where the album shows its cover | — |
| band, text | owner label and facts **above** the name, no kicker or boxed owner pill; the **description** when present | owner tooltip: "You created it" / "Created by {{label}}" |
| band, name (desktop) | name with a bare ⋯ beside it, no pencil | double-click the name to rename; ⋯ keeps rename, source link, refresh and delete |
| band, verbs (desktop) | icon-only square play key in the list's colour; bare shuffle, library and download; 18 px glyphs, 36 px hit areas | existing play / shuffle / library / download actions; words in tooltips and accessibility labels |
| library verb (desktop) | + for none or partial, green ✓ only when every song belongs to the current account's library | add missing songs / remove all; partial tooltip includes x/y; playlist ownership never determines this state |
| download verb (desktop) | ↓ for none or partial (x/y in tooltip), ring + mono n/m while downloading, green ✓ when all are downloaded | download all / remove download; unchanged account and desktop capability checks |
| top right, across from back | two floating boxes: "Select songs" (lit yellow while selecting), then the whole-list download control | enter/leave selection · download all / remove all |
| list with no songs | the select box is not drawn; the download box is | — |
| songs | a bare list, no card per row and no rule above it; each row keeps its **cover** (a list spans albums, unlike an album page), title, artist, duration, its download control and ⋯ | play from that row |
| the playing row | washed in the list's colour, as on the album | — |
| selecting | the selection bar takes the tab bar's place (the album/Library selection bar) | — |
| navigation (phones) | a page over the Listas tab, as the album page is over Library: full-bleed band under the status bar, back chevron, edge swipe; mini player and tab bar stay | back → the grid |
| leaving Listas and coming back | the same list is still open | — |
| tapping the Listas tab while on it | back to the grid | — |
| loading, a copy already on the device | the songs show at once, no "Cargando pistas…" | — |
| offline / unsaved / unresolvable songs | the existing notes under the list, unchanged | — |

## Copy (exact strings)

| where | text |
|---|---|
| owner (above name) | account `label`; tooltip "You created it" / "Created by {{label}}" |
| facts line | `contracts/playlist-page.json` — "{{n}} canciones · {{duración}}", "1 canción", offline "· {{n}} descargadas" / "· 1 descargada". ⚠ "songs", no longer "pistas", to match the album |
| select box (accessibility/tooltip) | "Select songs" / "Salir de la selección" |
| queue verb (accessibility/tooltip) | "Añadir la lista a la cola"; toast ""{{lista}}" añadido a la cola" |
| play / shuffle | "Play" / "Shuffle" |

## Decided per app on purpose

- Visual language: Marcado on the phones, Picnic on the desktop — "the album
  page" means each app's own album page, not iOS's pixels.
- Desktop navigation is its own (no tab bar, no edge swipe); the desktop's
  playlist view adopts its album page's hero + list, keeping its table if the
  album page has one. Selection on the desktop is whatever its album/library
  tables already do.
- Where the select control sits on the desktop (beside the download, in the
  hero's top-right or its toolbar) is the desktop's call; on both phones it is
  the floating box left of the download.
- Desktop keeps its existing list-colour gradient in light and dark. Search
  moves to the table toolbar (card 03); the hero accepts the transitional
  `search` prop without displaying it.
- **iOS and Android follow-ups are required** for the shared header target:
  remove the kicker, put the facts above the name, and resolve the owner account
  label with the same tooltips. This desktop card does not implement those ports.
  Their existing queue verb, selection/download placement and native navigation
  remain as described above until separate sessions reconcile those controls.
- If account metadata is inaccessible or unavailable, show the shared missing-value
  vocabulary rather than guessing a name. Desktop `/api/users` is owner-only;
  `/api/me` supplies the signed-in account's label.

## Pinned by

`contracts/playlist-page.json` — `facts` cases. Read by krobi-ios
`Tools/Checks/main.swift` (`PlaylistSummary.lineaDatos`), krobi-android
`ContratosTest`, and the renderer's playlist page tests.

## Not in scope

"Show full album" and "Más de" (album-only); the Listas grid itself;
any change to the rows' gestures, the track menu or the offline queues.
