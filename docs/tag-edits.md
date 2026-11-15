# Safe file tag edits

`GET /api/library/tags/{relPath}` returns fields, format, writable status and a
strong file revision in both `rev` and `ETag`. Members can read their own tracks;
missing and out-of-scope tracks both return 404.

An owner sends `PUT` to the same path with `If-Match: <rev>` (or `rev` in the
body) and `{"set":{"genre":null}}`. Only supplied fields change. Null or an
empty value removes the field. A stale revision returns 409 with
`detail.reason: changed-since` and the current tag view. A no-op returns
`changed:false` with a null `editId` and creates no history entry.

The field names are `title`, `artist`, `album`, `albumArtist`, `composer`, `genre`, `year`,
`trackNumber`, `trackTotal`, `discNumber`, `discTotal`, `compilation`, `bpm`,
`key`, `isrc`, `mbRecording`, `mbRelease`, `mbReleaseGroup`, `mbArtist`,
`mbAlbumArtist`, `comment`, `artists`, `albumArtists`, `titleSort`, `artistSort`,
`albumSort`, `albumArtistSort`, and `composerSort`. Text fields retain multiple values supplied as
arrays. Keys are written as compact musical note names; the analysis API keeps
its existing Camelot values. MP4's standard integer tempo atom rounds fractional
BPM. ID3 defaults to v2.4; `id3Version:3` requests v2.3 with UTF-16 and `; `
joined values. The same switch is accepted for batches.

`POST /api/library/tags/batch` accepts up to 500 `{relPath,rev}` items plus
`set`, and returns 202 with `editId` and `progressId`. Per-file conflicts are
recorded while siblings continue. A second batch or undo while a batch is
applying returns 409 `busy`. The existing `/api/update-tags` body and response
remain supported, with a `Deprecation` header. It reads the current revision at
execution time.

On desktop, an owner's selection of two or more songs offers **Edit tags** in
the selection bar and song menus. Shared values stay visible; differing values
show **Mixed**, with their originals in a tooltip. Titles remain individual.
Only changed fields enter the patch, and **Use original value** removes a field
from it. Bulk writes always show a confirmation naming the fields and file
count, including when single-song confirmation is disabled. Selections above
500 files must be narrowed before editing.

The result notification reports changed songs and counts skipped or failed
files. **Details** shows the journal's per-file diff and outcome; **Undo**
reverses that one journal entry. A file changed on the nest is skipped rather
than overwritten. The existing journal detail response now also has a declared
OpenAPI model; its keys and values remain unchanged.

`GET /api/library/edits` lists owner-visible history with counts, cursor
pagination and an ETag. `GET /api/library/edits/{id}` exposes per-file outcomes.
`POST /api/library/edits/{id}/undo` returns 202 and a compensating `editId`.
Undo checks every file, runs in reverse order, and refuses changed files,
newer edits and entries older than 90 days with `changed-since`, `newer-edit`
and `expired`. Repeating undo returns the same entry; undoing that entry is
redo. The journal retains at most 5,000 completed entries, independently of job
retention. Edit, batch and undo routes honor `Idempotency-Key` for 24 hours.

All mutagen saves live in `backend/app/domains/metadata/tagwriter.py`.
The metadata adapter, analysis write-back, cover embedding, acquisition and
move retagging use this boundary. Library writes additionally pass through
`music/tag_edits.py`. Private acquisition staging has no published library
identity to undo yet.

`MetadataRepository.write_id3_tags` is a compatibility adapter to this same
writer and field table. Its default fills only empty native fields; explicit
metadata edits and fresh download imports pass `overwrite=True`. The gap
decision runs under the file lock, and false compilation flags count as present.
Track/disc pairs with a missing number are skipped; no total-only ID3 frame or
MP4 pair is created. Vorbis totals remain independent comments, while missing
track/disc numbers are omitted. MP4 `tmpo` uses
`int(round(float(value)))`. Skipped pairs and tempo changes that round to the
existing integer leave file bytes and edit history unchanged.

MusicBrainz recording identity uses `UFID:http://musicbrainz.org` in MP3;
release, release-group and artist identities use `TXXX:MusicBrainz Album Id`,
`TXXX:MusicBrainz Release Group Id` and `TXXX:MusicBrainz Artist Id`. MP4 uses
the corresponding `----:com.apple.iTunes:MusicBrainz … Id` freeform atoms.
Vorbis uses `MUSICBRAINZ_TRACKID`, `MUSICBRAINZ_ALBUMID`,
`MUSICBRAINZ_RELEASEGROUPID` and `MUSICBRAINZ_ARTISTID`. Gap fill also respects
the older MP3 `TXXX:MusicBrainz Track Id` recording alias. Acquisition request,
retry and audio metadata models retain known release-group and artist IDs.

The writer holds one shared per-path lock, checks size, nanosecond mtime and a
tag digest, modifies a sibling copy, fsyncs it, records the expected replacement
identity in `analysis.sqlite`, checks the source again, atomically replaces it,
and fsyncs the directory. It refuses hardlinks and insufficient free space.
Untouched ID3 frames retain their serialized bytes when the version is unchanged;
a version switch necessarily changes frame headers and text encodings. The analysis signature and
scan memo are refreshed without scheduling analysis for a tag-only edit.

Startup resolves unfinished journal rows against their recorded before/after
identities. Applied files stay applied; untouched rows become
`skipped: interrupted`; ambiguous files become `failed: unknown-state`. Work
is never replayed. Leftover sibling temporary files are removed. Journal rows
are committed before replacement, so interruption after replacement remains
recoverable even if the following signature update failed.

These guarantees assume one backend process and a filesystem that supports
atomic same-directory replacement and fsync. Local files and all four requested
formats are exercised by tests; SMB/NFS durability has not been verified.

Library reads use the writer's field table for MP3, FLAC, Ogg Vorbis, M4A and
Opus. The existing `artist` and `genre` strings keep their first native value;
additive `artists` and `genres` arrays retain all values. `ARTISTS` takes priority
over an artist credit. Only a single legacy credit is split, on semicolons,
spaced slashes, `feat.` or `ft.`; bare slashes and ampersands stay intact, with
an explicit artist exception list in the reader. Native multi-value credits and
explicit `ARTISTS` values are never split again.

Tracks also expose `albumArtist`, `albumArtists`, `discNumber`, `compilation`,
`year` and the sort fields. Tagged disc numbers control numeric disc/track
ordering and OpenSubsonic `discNumber`; recognized disc folder names are a
fallback. Album artist controls the album credit; a flagged compilation without
one uses `Various Artists`, keeping every track's own credit. Physical folder
media keys remain stable. Scan-cache schema v4 invalidates old tag stamps and
folder signatures once, retaining the last published listing while offline.
