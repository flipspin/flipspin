# State backups

The nest takes its first state backup ten minutes after server startup and
another every 24 hours while it runs. Owners can also use **Settings → System
→ Status → Back up now**, or `POST /api/server/backups`. The owner-only
`GET /api/server/backups` reports the stamp, payload size in bytes, reason and
verification result. Status shows the latest verified backup's age and its
reason in a tooltip; a failed attempt does not advance that time.

Backups live in `~/Krobi/backups/<UTC stamp>/`, beside the configured playlist
directory when the data directory is relocated. Each directory contains a
versioned manifest with the app version, reason, file names, sizes and SHA-256
checksums. Snapshot files and directories are private to the server account.
SQLite uses its online backup API, including committed WAL data, and every
copy passes `PRAGMA integrity_check` before publication. JSON stores use the
app's atomic whole-file writes, so each captured file is complete. Independent
stores are captured sequentially; this is not a single cross-store transaction.

Included: `users.json`, `user_tracks.json`, `instance.json`, `providers.json`,
`lyrics.json`, `subsonic-stars.json`, the playlist tree, `jobs.sqlite`,
`analysis.sqlite` and additional SQLite stores under the data directory.
Configured locations of the named stores are honored. Music, stems, models,
tools, temporary files, logs and the backup tree are excluded. Rebuildable
JSON caches and credential files are outside the selected state stores. Audio and lyric sidecars beside audio need their own media backup.
Encrypted provider credentials and the nest's secret key need a separate,
secure recovery copy; these state snapshots do not contain them.

Retention keeps the newest snapshot from each of seven distinct UTC days,
plus the newest from four older ISO weeks. Manual and pre-operation snapshots
participate in those buckets. Invalid snapshots and pending directories are
left alone for inspection. Existing migration snapshots keep their own
retention and failure markers; migration backups reuse the same online SQLite
copy primitive and do not take a second whole-state backup.

## Restore

Stop the server first, then run from the backend directory with the same
Python environment and configuration used by the server:

```sh
python -m app.backup restore 20261112T120000.000000Z
```

For a relocated data directory, add `--data /path/to/data`. This uses standard
store names under that directory; omit `--data` to honor configured individual
store paths. Run the command as the server account. A kernel-held lock refuses
restores while the server runs, refuses server startup during a restore, and
is automatically released if the process exits unexpectedly. Servers from
before this feature must be stopped manually because they do not hold this lock.

Restore verifies the complete manifest, sizes, checksums and SQLite integrity
before moving any current store. It stages replacement files beside their
destinations, moves current stores and SQLite sidecars into private
`.before-restore-<UTC stamp>` directories beside each destination, then
publishes the replacements. Playlists or SQLite stores created after the
snapshot are moved aside too. A publication error rolls the moves back.
The CLI prints recovery directory locations. Keep them until the restored
nest has been checked; they are excluded from future backups and retention.
An abrupt process or machine failure during restore may require recovering
those preserved files manually before starting the server.

## Before risky operations

Use the dependency container's synchronous
`get_backups().backup_now("before-bulk-tags")` port before changing state.
Failure raises so the caller can abort. This port backs up state, not music
bytes; tag writers must retain their own audio/tag undo mechanism. Schema
migrations already snapshot their stores and must not call this port again.
