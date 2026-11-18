# Página de álbum — the songs lead; "Show full album" and "Más de" follow them

## What it does

An album's page opens on its songs. The two things that are not the songs —
asking the catalog for the whole album, and the artist's other records — come
after the list and stay quiet: no bordered boxes around them, because
hard-cornered boxes around the tracklist "took protagonism out of the songs
list" (the maintainer). "Más de <artista>" folds away, and stays folded once folded.

## Server

None.

## States and controls

| when | the page shows | tapping/clicking it does |
|---|---|---|
| album open, online | header · songs · "Show full album" · "Más de …" (if any) | — |
| "Show full album", off | **after the last song**, plain text with its disc icon, no border, no fill | asks the catalog; missing songs slot into the list in their positions |
| it, loading | spinner in place of the icon, disabled | — |
| it, on | label "Only the ones I have", **coral** text and icon, still no box | back to only the owned songs |
| on, with songs missing | beside it, "Conseguir/Añadir las N que faltan" in the same plain style | acquires them |
| offline | neither control is drawn | — |
| artist has other albums | heading "MÁS DE <ARTISTA> n" (uppercase, muted) with a chevron at its trailing end; the **whole heading** toggles | folds/unfolds the covers |
| open (default) | chevron points down; the other albums' covers below, no card around them, left-aligned with the heading | a cover opens that album |
| folded | chevron points right; no covers | — |
| the choice | remembered across albums and launches | — |
| no artist, or no other albums by them | no section at all | — |

Which albums "Más de" lists is a rule: `contracts/album-page.json`.

## Copy (exact strings)

| where | text |
|---|---|
| toggle off / on | "Show full album" / "Only the ones I have" |
| missing | phone "Añadir las {{n}} que faltan" · desktop "Conseguir las {{n}} que faltan" (each app's existing string, unchanged) |
| section heading | "Más de {{artista}}" (drawn uppercase), then the count |
| accessibility value of the fold | "Desplegado" / "Plegado" |

## Decided per app on purpose

- Visual language: Marcado on the phones, Picnic on the desktop — "no box" means
  each system's borderless/text button, not a copy of the phone's pixels.
- The desktop's song table keeps its own bordered card; only the two pieces
  around it lose theirs.
- Covers per row in "Más de": three on a phone; the desktop fits its width.
- The fold's stored key: iOS `album.masDeAbierto` (UserDefaults); others use
  their own preference store.

## Pinned by

`contracts/album-page.json` — `masDe` cases. Read by krobi-ios
`Tools/Checks/main.swift` (`Album.masDelArtista`), the renderer's tests, and
krobi-android `ContratosTest`.

## Not in scope

Folding the song list; any change to the header, play/shuffle/queue keys or the
row download controls (the maintainer kept those as they are).
