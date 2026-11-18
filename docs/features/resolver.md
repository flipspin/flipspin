# resolver — fix a song the library has in the wrong album or the wrong cut

## What it does

On a catalog album page, and on a library album's "Show full album", a song
the library already answers for some other way gets one verb: move the file into
this album, or swap the different cut you have for this one.

## Server

- `POST /api/library/move-track` `{path, albumDir?, albumTitle?, trackNumber?}` →
  `{success, path}`. Moves the file into the album's folder (`albumDir`, or where a
  download of `albumTitle` would land), retags it (MP3 only) and repoints user rows,
  playlists, lyric and stems. 409 = that album already has a file of that name (the
  detail is the sentence to show).
- `POST /api/browse/acquire`: per-track `replaces` = the server path of the cut it
  supersedes; skips the dedupe; once the file lands the old one is deleted. A failed
  download deletes nothing.

## States and controls

| when | the row shows | tapping it does |
|---|---|---|
| owned, filed under another album (tag **and** folder differ from the page's) | "Move here" | move-track, no confirm |
| `nearMatch` (the library has another cut) | "Swap for this version" | confirm, then acquire with `replaces` |
| neither | "+" | acquire |

## Copy (exact strings)

| where | text |
|---|---|
| move | "Move here" |
| moved | ""título" ahora está en "album"." |
| swap | "Swap for this version" |
| confirm | "Swap for this version?" / "Se borrará tu versión de 4:50." (no length: "Your version will be deleted.") / "Swap" · "Cancel" |
| 409 | the server's sentence |

A row shows **one** of these, never two: no "+" beside "Swap". Pinned by
`rowControl` in the case file.

## Decided per app on purpose

- The move control: an icon (iPhone), a text chip (Android), a text button (desktop).
- The confirm: two taps in the row (iPhone), a sheet or dialog (Android), a dialog (desktop).

## Still open

- **After a swap.** Only the desktop says "Version swapped.".

## Pinned by

`contracts/resolver.json` (folding, when "Move here" shows, the confirm line) ·
`contracts/wire/library-ownership.json`, `library-move-track.json`.
