# Missing files

Owners open **Settings → Library → Missing files** to review absent songs.
The list groups songs by the first unavailable folder, or by an individual
missing file. It names account and playlist references and retained corrections.
Owners also see greyed, unplayable missing rows in album pages. Member catalog
listings exclude those ghosts; their personal missing-reference API is unchanged.

`GET /api/library/missing` returns an ETag, availability, library count and rows.
Before offering removal it compares remembered size, duration and raw tag hash
against present candidates. A unique match appears as `movedTo`; accepting it
preserves references through `TrackRelocator.repoint`.

`POST /api/library/missing/preview` accepts `relPaths` and either a
server-relative `folder` or one target file key. Folder recovery matches file
names recursively, retaining ambiguous and unmatched rows for review.
`POST /api/library/missing/apply` accepts reviewed `{relPath,target,rev}` rows.
It checks target revisions and source absence again before repointing. It never
moves audio or writes tags. Targets with existing personal references or
corrections are refused as collisions.

`POST /api/library/missing/remove` accepts `relPaths` and optional `confirmLarge`.
It refuses absent, empty, unreadable or changed-device roots. Removing more than
20% of known library rows needs the separate counted confirmation. A restored
file is skipped as `not-missing`; a uniquely re-identified move is skipped as
`moved`; repeated removals are skipped as `already`.

Removal journals account rows, playlist positions, play receipts and history,
lyrics records, analysis and provenance. Stems move to a private recycle folder.
Undo uses the existing `/api/library/edits/{editId}/undo` endpoint and restores
those references. Interrupted removals compensate from the durable snapshot
instead of replaying deletion. Audio and lyric sidecar files are untouched.
Trusted plugins can register JSON snapshot/drop/restore participants through
`container.get_library_keys().register(name, participant)`.

All four household endpoints require owner authorization. Existing member
`GET /api/me/library/missing` and `DELETE /api/me/library` retain their scope.
