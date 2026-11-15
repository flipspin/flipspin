# Play history

Listening events live in `jobs.sqlite` in `play_events`, owned by the
`user_library` domain. Each accepted receipt adds one event in the same
transaction. Events retain the account, track key, start time, optional played
seconds, completion flag, source and authenticated device id. The track key is
one library-relative path column, ready for a later stable-id migration.

`POST /api/me/plays` retains its existing single-play and offline-batch bodies
and responses. Both accept optional `startedAt` (timezone-aware),
`playedSeconds` (finite, nonnegative), `completed` and `source` (`desktop` or
`phone`). Omitted completion means a submitted play (`true`); omitted played
seconds remain unknown (`null`). Start time defaults to the receipt's listening
time. Source defaults from a recognized mobile user agent, otherwise `desktop`.
Clients can send source explicitly; device identity always comes from the
credential. Source describes the client and is not an authorization signal.
Offline retries retain the existing account/track/listening-time deduplication.
An `Idempotency-Key` also deduplicates a single-play request.

Subsonic `scrobble` submissions use the same recorder with source `subsonic`.
`submission=false` writes nothing. Optional `time` values are paired with song
ids and interpreted as epoch milliseconds. A repeat with the same song and
time is one receipt. Played duration is unknown; a scrobble does not prove the
whole song was heard.

Counts remain the pre-receipt baseline plus recorded plays; last-played remains
the maximum receipt listening time, independently of an optional start time.
Existing library response keys are unchanged. The upgrade copies existing
receipts once, preserving their times and baselines without inventing events
for older aggregate counts. Old receipts have no device or duration metadata;
source uses the `desktop` fallback because provenance cannot be recovered.

`TrackRelocator` moves events, receipts and baselines before merging membership
rows. Merging keys retains every event, even if both keys had a receipt at the
same instant. Missing files and removal of membership do not delete history.
Neither request-receipt expiry nor job retention prunes listening events.

## Export

`GET /api/me/plays/history` requires a real owner account and always exports
that caller's events. It accepts no account selector. Members retain their own
counts and library rows; history export returns 403. Credentials without a real
account return 409, as on the other personal-library routes.

Query parameters:

| Parameter | Meaning |
| --- | --- |
| `from` | Optional inclusive start time with timezone |
| `to` | Optional exclusive end time with timezone |
| `limit` | Page size, 1–500, default 100 |
| `after` | The previous page's `nextCursor`; retain the same time bounds |

The response is `{events, nextCursor}`. Events contain `id`, `relPath`,
`startedAt`, `playedSeconds`, `completed`, `source` and `deviceId`. Times are UTC.
Rows are newest first, ordered by start time and id, using an account-scoped
cursor so tied timestamps page without duplicates. A cursor survives a track
move. A null `nextCursor` marks the last page. Unknown cursors, invalid bounds
and invalid page sizes return 422. History includes missing and removed songs.
Retention is unlimited, with an index on `(user_id, started_at)`.
