# Spotify data-export fixtures

Nobody on this project has ever held a real Spotify export. One was requested;
Spotify quotes up to 30 days. Everything in `account_data/` and
`extended_streaming_history/` is therefore **synthetic content in a real
layout**: the structure, key spellings and null-vs-object conventions were
copied from actual exports that other people published, the names and ids were
replaced with harmless ones.

That is a weaker claim than "tested against a real export", and it is written
down here rather than implied, because the difference matters the day the real
file arrives.

## When the real export arrives

1. Drop the ZIP in `real/` (git-ignored — it is somebody's listening history,
   and an export contains an email address, birth date and postal code).
2. Run `pytest tests/unit/test_spotify_export_parser.py`. The fixture tests
   pin the layouts below; the real file either matches one of them or it does
   not.
3. Upload it through the app once and read `unreadMembers` in the parse
   response. **Every JSON member should come back `known` or be consumed.**
   Anything `unrecognized` is the layout we guessed wrong about, with its
   shape printed next to it.
4. Whatever differs: fix the parser, then update the fixture here so the
   difference stays fixed.

## A real export (2026)

A real account-data export was checked against the parser in 2026. **The
playlist and library layouts above held exactly**: every playlist plus the
saved-songs list parsed, the only items not imported being podcast episodes,
as designed. Local files came through title-only, as documented.

What the published exports had not shown was the rest of the file set. Nine
members came back `unrecognized`, and the playlist picker lists those as files
it could not read:

- new files: `AdsIdentitySecondPartyIdentifiers.json` (`ids`), `AgentGateway.json`
  (`conversations`), `Identifiers.json` (`identifierType`/`identifierValue`),
  `iDJAudio.json` (`filesMetadata`), `MessageData.json` (keyed by
  `spotify:chat:<id>`), `Wrapped2025.json` (`topArtists`, `topTracks`, …),
  `YourSoundCapsule.json` (`stats`, `highlights`);
- `Follow.json` reshaped to `userIsFollowing`/`userIsFollowedBy`/`userIsBlocking`;
- `Payments.json` as `[]` for an account with no payments on file.

`account_data_2026/` reproduces that file set with harmless values, and the
parser now names every one of them. The folder was `Spotify Account Data/`.

## The two tiers

Spotify offers two downloads and they are not the same file set
([Spotify: Understanding my data](https://support.spotify.com/us/article/understanding-my-data/)):

| Tier | Wait | Contains playlists? |
|---|---|---|
| **Account data** | a few days | **yes** — `Playlist1.json`, `YourLibrary.json` |
| **Extended streaming history** | up to 30 days | no — only play events |

A user who requests the wrong one waits weeks for a file with no playlists in
it, which is why the parser recognises the extended package explicitly and says
so instead of reporting "nothing found".

## `account_data/`

Real member lists from published exports — the file set varies with what the
account actually has (family plan, payments, Marquee):

- `Follow.json Identifiers.json Identity.json Inferences.json Payments.json Playlist1.json Read_Me_First.pdf SearchQueries.json StreamingHistory0.json Userdata.json YourLibrary.json`
  ([jabpcomplex/spotify-analisis-de-datos `MyData/`](https://github.com/jabpcomplex/spotify-analisis-de-datos/tree/main/MyData))
- `DuoNewFamily.json FamilyPlan.json Follow.json Payments.json Playlist1.json Read Me First.pdf SearchQueries.json StreamingHistory0..2.json Userdata.json YourLibrary.json`
  ([yasseriz/Spotify `MyData/`](https://github.com/yasseriz/Spotify/tree/master/MyData))
- `Follow.json Marquee.json Playlist1.json SearchQueries.json StreamingHistory0.json StreamingHistory1.json YourLibrary.json`
  ([ardaturanSabanci/CS210_Fall23_Term_Project](https://github.com/ardaturanSabanci/CS210_Fall23_Term_Project))

Note the folder name is not stable either (`MyData/`, `Spotify Account Data/`,
or no folder at all), and playlists spill into `Playlist2.json`, `Playlist3.json`
for large accounts. This is why the parser matches **structure, never filename**.

### `Playlist1.json`

```json
{"playlists": [{"name": …, "lastModifiedDate": "YYYY-MM-DD", "collaborators": [],
                "items": [...], "description": null, "numberOfFollowers": 0}]}
```

Verified against
[JoeTomkinson/spotify-data-viewer `demo-data/Playlist1.json`](https://github.com/JoeTomkinson/spotify-data-viewer/blob/main/demo-data/Playlist1.json),
[oumayma-yakoubi/SpotifyDataViz](https://github.com/oumayma-yakoubi/SpotifyDataViz/blob/main/data/user-1/Playlist1.json),
[christinamadian/final-spotify-project](https://github.com/christinamadian/final-spotify-project/blob/main/Playlist1.json),
[arv-anshul/spotify-dashboard](https://github.com/arv-anshul/spotify-dashboard/blob/main/data_files/AllPlaylists.json)
and the JSON Schema in
[datavizstudy/viztool `Spotify.schema.json`](https://github.com/datavizstudy/viztool/blob/main/src/core/src/transformers/Spotify.schema.json)
(which spells the filename pattern as `^Playlist[0-9]*\.json$`).
`purarue/HPI`'s [`my/spotify/gdpr.py`](https://github.com/purarue/HPI/blob/master/my/spotify/gdpr.py)
reads the same four keys.

**An item is one slot with four mutually exclusive fillers.** Exactly one of
`track` / `episode` / `audiobook` / `localTrack` is an object; the rest are
`null`. This is the single most important thing the old parser got wrong — it
treated `"track": null` as a broken row:

```json
{"track": null,
 "episode": {"episodeName": …, "showName": …, "episodeUri": "spotify:episode:…"},
 "audiobook": null, "localTrack": null, "addedDate": "2024-02-10"}
```

Local files carry no names at all, only the URI Spotify synthesised from the
file's tags — and `addedDate` is absent on those items
([real example](https://github.com/mini-pw/2021Z-DataVisualizationTechniques/blob/main/projects/project3/krzyzinski_wojciechowski_zolkowski/eda/data/pawel/Playlist1.json)):

```json
{"track": null, "episode": null,
 "localTrack": {"uri": "spotify:local:::Don+Poldon+-+Kosmokwachy:153"}}
```

`spotify:local:<artist>:<album>:<title>:<seconds>`, percent-encoded with `+`
for spaces. The artist and album segments are routinely empty because the file
had no tags, so only the title can be relied on.

`audiobook` is newer than `episode`: exports from 2023 and earlier have only
`track`/`episode`/`localTrack`, which is why the parser tests presence rather
than requiring the key.

### `YourLibrary.json` — saved tracks, i.e. "Liked Songs"

```json
{"tracks": [{"artist": …, "album": …, "track": …, "uri": "spotify:track:…"}],
 "albums": […], "shows": […], "episodes": […], "bannedTracks": […],
 "artists": […], "bannedArtists": […], "other": ["spotify:local:…"]}
```

Note the *flat* spelling here (`track` is the title string) versus the nested
`trackName` inside a playlist item — the same document set uses both.
Older exports have no `uri` on the track entries at all
([slevin48/music](https://github.com/slevin48/music/blob/main/spotifyData/YourLibrary.json)),
newer ones do
([JoeTomkinson](https://github.com/JoeTomkinson/spotify-data-viewer/blob/main/demo-data/YourLibrary.json)).
`other` is a bare list of `spotify:local:` URI strings.

### `StreamingHistory0.json` — basic play history

Bare array of `{endTime, artistName, trackName, msPlayed}`
([slevin48/music](https://github.com/slevin48/music/blob/main/spotifyData/StreamingHistory0.json)).
Play events, not playlists: recognised and reported, never imported.

### The rest

`Userdata.json`, `Follow.json`, `SearchQueries.json`, `Marquee.json`,
`Inferences.json`, `Payments.json`, `Identity.json` hold no music the app can
act on. Field names follow
[datavizstudy/viztool's schema](https://github.com/datavizstudy/viztool/blob/main/src/core/src/transformers/Spotify.schema.json).
They are here so the tests can prove the parser reports them as *recognised and
uninteresting* rather than as "could not interpret" — a report that cries wolf
about nine files is a report nobody reads.

## `extended_streaming_history/`

`Streaming_History_Audio_<years>_<n>.json`, a bare array of play events keyed
`ts`, `ms_played`, `master_metadata_track_name`,
`master_metadata_album_artist_name`, `master_metadata_album_album_name`,
`spotify_track_uri`, plus `episode_*` / `audiobook_*` and the
`reason_start` / `reason_end` / `shuffle` / `skipped` telemetry
([jprkindrid/rewrapped-spotify sample](https://github.com/jprkindrid/rewrapped-spotify/blob/main/sampleParsedTrack.json),
[tsirysndr/rocksky fixture](https://github.com/tsirysndr/rocksky/blob/main/apps/cli/src/lib/__fixtures__/import/spotify-sample.json),
[OpenMined/datasets_loader field dump](https://github.com/OpenMined/datasets_loader/blob/main/static_datasets/demo_spotify/assets/asset_1/Streaming_History_Audio_2011-2012_0_schema.txt)).
The filename convention is confirmed by the importers in
[Yooooomi/your_spotify](https://github.com/Yooooomi/your_spotify) and
[gabehf/Koito](https://github.com/gabehf/Koito/blob/main/docs/src/content/docs/guides/importing.md),
both of which key on `Streaming_History_Audio`.

Some exports spell the IP and user-agent columns `ip_addr_decrypted` /
`user_agent_decrypted`; nothing here depends on either.

## What is still unverified

- Whether a **current** (2026) export still uses these names. Every sample
  above is 2020–2025.
- `Identifiers.json`, `FamilyPlan.json`, `DuoNewFamily.json`: seen in real file
  listings, contents never inspected. They will show up in the report as
  `unrecognized`, which is the correct answer — we genuinely do not know them.
- Non-Latin playlist names, emoji in names (one sample has them) and very large
  exports (hundreds of playlists) are all plausible and untested at size.
