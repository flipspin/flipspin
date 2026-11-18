# Géneros — every song carries its album's genre, read in the app's language

## What it does

A song added from Browse arrives with its genre and year already in its tags,
so the album page's meta line and the library's "Genre" filter have something
to show. The tag is Spanish; with the language switch on English the desktop
shows the English name instead — one name, never both.

## Server

No route changes. `POST /api/browse/acquire` now fills `genre` and `year` on
the tracks it hands the downloader, in its background job, through Deezer:

- the track's ISRC → its album; else `search/album` (title **and** artist must
  match after normalisation); else `search/track` on the title. No match, no
  genre — never a guess;
- `/album/{id}` asked with `Accept-Language: es` and `en`, paired by genre id
  (`DeezerRepository.fetch_album_genres`);
- the tag is the Spanish names, de-duplicated, at most 3, `", "`-joined
  (`app/domains/metadata/genres.py`); one lookup per album per process;
- only while Deezer is enabled in Settings → Sources. A failed lookup leaves
  the tag empty and the download goes ahead.

Songs acquired before this were backfilled once with a one-off maintenance
script (run on the server; dry run by default, batches with `--limit`,
resumable, every write logged with its previous value).

## States and controls

| when | shows |
|---|---|
| tag present, language Español | the tag as written ("Latino, Alternativo") |
| tag present, language English | each genre through `genres.en.json` ("Latin Music, Alternative"); a name it does not know as written |
| no tag | nothing — the meta line drops the slot |

## Copy (exact strings)

Data, not UI copy: Deezer's own genre names in each language.

## Decided per app on purpose

The phones are Spanish-only and show the tag as written; only the desktop has
the language switch, so only it carries the table
(`renderer/src/albums/genres.en.json`).

## Pinned by

`backend/tests/unit/test_genres.py` · `renderer/.../albums/genreLabel.test.ts`

## Not in scope

Filtering Library on the phones by genre; editing the table by hand (the
backfill script regenerates it from Deezer).
