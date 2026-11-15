# opensubsonic — any Subsonic music app can play a Flipspin nest

## What it does

Flipspin speaks the Subsonic API with the OpenSubsonic extensions under `/rest/`, so
play:Sub, Amperfy, substreamer, Symfonium, Tempo, DSub, Ultrasonic, Feishin and
Supersonic can browse, search, stream, star and manage playlists on a nest. It plays what is
already on the server. Catalog browsing, downloads and the "ya la tienes"
markers stay in Flipspin's own apps. Native Flipspin iOS and Android apps are
**coming soon**, not released with v0.1.0. For mobile today, use OpenSubsonic
apps with an app password from the first-run wizard or Settings → My account.
In Settings, "Apps de música → Agregar una app de música" starts with the app.
Symfonium, Crossonic and Nautiline select an API key; Amperfy, substreamer, Feishin,
Supersonic, Tempus and "Other app" select an app password. "Choose the type"
overrides this choice. Neither credential is marked preferred.

## Server

All under `/rest/{method}` and `/rest/{method}.view`, GET or POST
(form-encoded body, the `formPost` extension). `f=json` answers JSON; anything
else answers XML (`xmlns="http://subsonic.org/restapi"`). Every answer carries
`status`, `version` (1.16.1), `type: "krobi"`, `serverVersion`, `openSubsonic: true`.

### Credentials

Not `require_api_token`: `/rest/` has its own auth, in the request parameters
(clients cannot send headers to an `<audio>` source either).

| parameters | accepted when |
|---|---|
| `apiKey` | it is a device token of a real account (`apiKeyAuthentication` v1). Combining it with `u`, `p`, `t`, `s` or `jwt` (even empty) → error 43. |
| `u` + `t` + `s` | `t == md5(secret + s)` for one of that account's **app passwords** |
| `u` + `p` (plain or `enc:<hex>`) | `p` is one of that account's app passwords or API keys |

An **app password** is a device on the account (`POST /api/me/devices/app-password`,
body `{label}`, answers `{device, token}` once). It is typeable
(`xxxx-xxxx-xxxx-xxxx`, 80 bits), it also works as that device's token, and it is
revoked like any device. Its plaintext is kept encrypted with the server's
credentials key, because token auth (`t` + `s`) needs it. The account password
is never accepted on `/rest/`: clients resend credentials on every request.

An **API key** is minted by `POST /api/me/devices/api-key` with `{label}` and
returns the declared `CreateDeviceResponse` (`{device, token}`, 201). Owners and
members create keys only for their own account. It uses the existing household
token generator and SHA-256 verifier in the account directory; it is never
written to `subsonic-app-passwords` or another recoverable secret record. The
key has no expiry. Both kinds of credential appear as metadata in
`GET /api/me/devices` and can be revoked with `DELETE /api/me/devices/{id}`.
The one-time plaintext exists only in the mint response and the open reveal.
Application/HTTPX and Uvicorn access logs redact query credentials (`apiKey`,
`p`, `t`, `jwt`), including URL-encoded parameter names.

The pairing dialog shows the nest's routable base URL (scheme and port, no
`/rest`), username for password mode, and the secret, each with Copy. Creation
saves immediately. "Done" discards the secret and opens the waiting step;
`GET /api/me/devices` is polled every two seconds while the dialog is open.
First successful Subsonic use changes this to "Connected". Music-app rows show
the chosen name, credential type, client-supplied `c`, last use (or "unused"),
and Quitar. A key's `tokenInfo` returns `{tokenInfo: {username}}` in JSON or XML,
with error 44 for an invalid/revoked key, under `apiKeyAuthentication` v1.

The device listing adds `credentialType`, `firstSubsonicRequestAt`,
`lastSubsonicRequestAt`, `subsonicClientName`, `lastSubsonicFailureAt` and
`lastSubsonicFailure` (`wrong-mechanism` or null). Old rows load with nulls.
First use and client changes persist immediately; last-use timestamps update
in memory on each successful request and flush at the usual five-minute cadence.
A recognized key submitted alongside token/salt records a typed failure without
counting as first use. A rejected `u+t+s` request cannot identify a verifier-only
key: it contains no key or device id, and SHA-256 cannot verify MD5(key + salt).
For an account with API keys, unmatched token auth returns 41; it is never
attributed to a guessed device. This also means a bad app-password token on such
an account gets 41, while valid app-password auth remains unchanged.

Errors (Subsonic codes, HTTP 200): 10 missing parameter · 40 wrong username or
password · 41 token auth cannot verify an API key · 42 auth mechanism not
supported (`jwt`) · 43 conflicting auth (including password plus salted token
or conflicting repeated auth parameters) · 44 invalid apiKey · 50 not authorized
· 70 not found. Throttling is a distinct generic error 0 with the retry message,
since the protocol defines no rate-limit code. Failure windows are bounded and
keyed by peer IP plus credential digest (or normalized username for token auth).
Forwarding headers are not consulted. Valid credentials are resolved before the
failure window is consulted, so stale retries cannot block valid credentials,
even on the same IP/username.

### Ids

Stable, opaque, derived from the library key, so nothing is stored:
`ar-<b64(artist name)>`, `al-<b64(mediaKey)>`, `tr-<b64(relPath)>`,
`pl-<b64(playlist name)>`. Cover art ids are album ids, or the playlist’s own id: playlist cover = 2×2 tile of the first four distinct covered albums (1–3 use the first cover). One music folder, id `1`.

### Methods

| group | methods |
|---|---|
| system | `ping`, `getLicense`, `tokenInfo`, `getOpenSubsonicExtensions` (public when credentials are omitted; validates credentials when supplied), `getScanStatus`, `startScan` |
| browsing | `getMusicFolders`, `getIndexes`, `getMusicDirectory`, `getArtists`, `getArtist`, `getAlbum`, `getSong`, `getGenres`, `getArtistInfo2`, `getAlbumInfo2` (empty info) |
| lists | `getAlbumList`, `getAlbumList2` (random, newest, alphabeticalByName, alphabeticalByArtist, byYear, byGenre, frequent, recent, starred), `getRandomSongs`, `getSongsByGenre`, `getStarred`, `getStarred2`, `getNowPlaying` (empty) |
| search | `search2`, `search3` (an empty query returns everything, paged: Symfonium syncs this way) |
| playlists | `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist` (Flipspin's own playlists, same owners and rules) |
| media | `stream`, `download` (the original file, `Range` honoured, no transcoding), `getCoverArt`, `getLyrics`, `getLyricsBySongId` (`songLyrics` extension, synced from the `.lrc` sidecar) |
| annotation | `star` / `unstar` (a song = a row in the account's library, `/api/me/library`; an album or artist = a per-account star), `scrobble` (a submitted play counts only for a song already in the account's library — listening never adds one), `setRating` (accepted, not stored) |
| user | `getUser` |
| play queue | `getPlayQueue` (empty), `savePlayQueue` (accepted, not stored) |

Anything else answers error 0, "método no implementado".

## Decided per app on purpose

Server only. The desktop and the phones are not Subsonic clients; the wizard
(Devices, with Subsonic selected and Flipspin disabled as "Coming soon")
and Settings → My account mint app passwords. Settings also mints OpenSubsonic
API keys without changing the first-run wizard.

## Pinned by

`backend/tests/integration/test_subsonic.py` — auth in all four forms, both
formats, browsing, search, stream with `Range`, playlists, stars, scrobble.
Also pins API-key mint/list/revoke for owners and members, verifier-only
persistence across store reload, tokenInfo in JSON/XML and query/form, plain
password compatibility, errors 41/42/43/44, isolated throttles and first-use
activity/failure signals. Renderer coverage lives in `pairing/SubsonicDeviceDialog.test.tsx`
and the My account integration cases in `settings/SettingsPage.test.tsx`.
`backend/tests/unit/test_subsonic_logging.py` checks file-log redaction and
compatibility with Uvicorn's positional access formatter.

## Not in scope

Transcoding (`maxBitRate`, `format`), podcasts, internet radio, shares,
jukebox, bookmarks, user management through Subsonic, ratings.
