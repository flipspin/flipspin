# API compatibility

The server's HTTP API is decoded by more than the desktop app in this
repository: native Flipspin mobile clients use it too in development and
sideloaded builds. They are coming soon, not released with v0.1.0;
[OpenSubsonic apps](features/opensubsonic.md) work for mobile today. The native
clients will release on their own schedule. None of them compile against this
code, so a renamed field is a runtime decode failure on a device that cannot be
updated in step with the server. This page is the rule set that follows from that.

## The rules

1. **Additive only.** A response may gain keys; it does not lose or rename
   them, and a key does not change type. A new behaviour gets a new key or a new
   route.
2. **`GET /api/status` is the handshake**, the one thing a client may ask before
   it holds a credential: `app` (always `"krobi"` — a client refuses any other
   server), `version`, `instanceId`, `name`, `pid`, `isInit`, `authMethods`, and,
   only while the server is unclaimed, `dataDir` and `setupTokenRequired`. It is
   the most sensitive contract of all. `name` (what the apps call the nest) was
   added later: always present on a current server, absent on older ones, so a
   client treats it as optional. It never names a person — the body is public.
3. **Listings stay narrow.** `GET /api/users` rows have exactly five keys
   (`id`, `label`, `role`, `createdAt`, `lastSeenAt`); per-account details such
   as devices live on their own routes (`GET /api/users/{id}/devices`) rather
   than being folded into the listing.
4. **Errors keep their status codes.** Clients branch on them: `401` no or bad
   credential, `403` exists but not yours, `404` does not exist, `409` a state
   conflict (a name already taken, a server already claimed, an action a
   synthetic principal cannot take), `429` throttled.
5. **Positional answers stay positional.** `POST /api/library/ownership`
   answers verdict *i* for query *i*; do not reorder, filter or deduplicate.
6. **Some legacy shapes are frozen as they are**, including their quirks —
   for example, `/api/listar-albums-con-metadata` names the album key `album`,
   and `dateAdded` is camelCase in an otherwise snake_case payload. Fixing them
   would break clients; add a new route instead.

7. **A song is always two segments: `<album key>/<file key>`.** Media, lyrics,
   stems and waveform routes and every `relPath` use it. In a flat
   library the album key is the folder name. In a nested one (`Artist/Album/`,
   disc folders such as `CD2/`) the folders are folded into one segment with
   `∕` (U+2215 DIVISION SLASH, never `/` and never `%2F`):
   `/api/media/Daft Punk∕Discovery/01.mp3`,
   `/api/media/Pink Floyd∕The Wall/CD2∕01.flac`. Treat each segment as opaque
   and percent-encode it like any other path segment. The album listing sends
   the keys as `mediaKey` (album) and `relPath` (track); prefer those to
   deriving a key from a filesystem path.

Older route names are Spanish (`/api/listar-albums`, `/api/buscar-canciones`)
because they predate the English ones; they are kept for the same reason.

`GET /api/uploads/space` requires a signed-in account, including members, and
returns integer `freeBytes` and `floorBytes` from the same disk measurement and
configured floor as acquisition's space guard. It reports those numbers even
below the floor; uploading may then return 507. Uploaded audio is filed under
`Artist/Album/<file>` using its tags, with `Unknown Artist` and `Unknown Album`
as fallbacks (or the source folder name for a missing album). Different bytes
with the same filename get `name (2).ext`, then higher suffixes; identical bytes
are reused. The SHA-256 remains the upload receipt identity, and library keys
fold the artist/album directories with `∕` as above.

The owner-only `GET /api/library/health` counts `addedThisWeek` from the scan
store's `tags.first_seen`, within the last seven days. Tag writes preserve this
time, and linked moves carry it to the destination. Rows present before tracking
began have `NULL` and are excluded. During the first seven days of tracking the
stat reports the arrivals recorded so far. Listing `dateAdded` still uses file
mtime for compatibility with existing client sorting.

`POST /api/logs/clear` is owner-only and accepts `{ "file": "app" }` or
`{ "file": "errors" }`. It returns `{ "file": "app", "clearedBytes": 123 }`
with the selected key and the previous file size. It truncates the current file
in place, preserves rotated backups, and logs the action with the requesting
device's name. Unknown keys return 422; missing or symlinked logs return
404. Older servers may return 404 or 405 because the route is additive.

## How it is enforced

- `backend/tests/integration/test_response_contracts.py` pins the shapes that
  shipped clients decode. A change that makes it fail is a contract change, not
  a test to update.
- The renderer's types are generated from the server's OpenAPI schema
  (`renderer/api-schema.json` → `renderer/src/api/generated/schema.ts`).
  Refreshing the committed schema is a reviewable diff:

  ```bash
  npm run api:generate -- --from http://127.0.0.1:8000 --save
  ```

  A wrong type is fixed by declaring a `response_model` on the FastAPI route,
  never by editing the generated file.

## Authentication on the wire

Clients send `Authorization: Bearer <token>`. `X-Krobi-Token` is also accepted.
`?access_token=` is accepted **only** because `<audio>` elements, native media
players and `EventSource` cannot send headers — so anything that parses a media
URL must strip the query string first.

The live reference for every route is the server itself: `/docs` (interactive)
and `/openapi.json`.

`POST /api/providers/{provider_id}/retry` is owner-only. It clears the source's
cooldown and wakes queued acquisition work while preserving its ladder level;
it returns the new `health` object. Unknown providers return 404. Provider
health includes optional `firstFailureAt` and `lastFailureAt` Unix timestamps.
Audio provider rows include `format` (null before any published download), with
measured `codec`, `bitrateKbps`, `container` and `transcoded` facts. YouTube also
includes the existing `ytdlp` version and update state.

`GET /api/sources/known` lists the server's known source ids, names, facts,
resolved install locations and `installed` state. It is owner-only, like the
existing source lifecycle routes. `POST /api/sources/install` accepts either
`{ "id": "youtube" }` or the existing `{ "location": "…" }` body. Locations
matching a known id or name resolve case-insensitively on the server. The saved
source-location setting or environment override takes precedence over the
catalog default. `/api/sources/missing` retains its existing migration shape.
