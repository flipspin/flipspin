"""Tests for the Spotify data-export parser.

The export layout is not a documented, stable API — Spotify can change it and
has no obligation not to. So these tests pin the *tolerance* the parser
promises (several field spellings, nested and flat shapes, partial garbage)
rather than one exact schema, and they pin the safety limits, since an export
is a user-supplied archive and therefore untrusted input.
"""
import io
import json
import zipfile
from pathlib import Path

import pytest

from app.domains.playlists.spotify_export import (
    DEFAULT_LIKED_NAME,
    MAX_MEMBERS,
    ExportedTrack,
    parse_spotify_export,
)
from app.exceptions import ValidationError


def _zip(files: dict) -> bytes:
    """Build an archive from {name: str | bytes | json-able}."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            if not isinstance(content, (str, bytes)):
                content = json.dumps(content)
            z.writestr(name, content)
    return buf.getvalue()


PLAYLIST_DOC = {
    "playlists": [
        {
            "name": "Rodada domingo",
            "lastModifiedDate": "2026-07-14",
            "items": [
                {
                    "track": {
                        "trackName": "Get Lucky",
                        "artistName": "Daft Punk",
                        "albumName": "Random Access Memories",
                        "trackUri": "spotify:track:69kOkLUCkxIZYexIgSG8rq",
                    },
                    "addedDate": "2026-01-02",
                },
                {
                    "track": {
                        "trackName": "Instant Crush",
                        "artistName": "Daft Punk",
                        "albumName": "Random Access Memories",
                        "trackUri": "spotify:track:2cGxRwrMyEAp8dEbuZaVv6",
                    },
                    "addedDate": "2026-01-03",
                },
            ],
        }
    ]
}


class TestHappyPath:
    def test_parses_a_playlist_from_a_zip(self):
        result = parse_spotify_export(_zip({"Playlist1.json": PLAYLIST_DOC}))

        assert result.playlist_count == 1
        assert result.track_count == 2
        assert result.source_files == ["Playlist1.json"]

        playlist = result.playlists[0]
        assert playlist.name == "Rodada domingo"
        assert playlist.modified_at == "2026-07-14"

        first = playlist.tracks[0]
        assert first.title == "Get Lucky"
        assert first.artist == "Daft Punk"
        assert first.album == "Random Access Memories"
        assert first.spotify_uri == "spotify:track:69kOkLUCkxIZYexIgSG8rq"
        assert first.added_at == "2026-01-02"

    def test_parses_raw_json_without_a_zip(self):
        result = parse_spotify_export(json.dumps(PLAYLIST_DOC).encode())
        assert result.track_count == 2

    def test_parses_from_a_path(self, tmp_path):
        p = tmp_path / "export.zip"
        p.write_bytes(_zip({"Playlist1.json": PLAYLIST_DOC}))
        assert parse_spotify_export(p).track_count == 2

    def test_tolerates_a_utf8_bom(self):
        raw = b"\xef\xbb\xbf" + json.dumps(PLAYLIST_DOC).encode()
        assert parse_spotify_export(raw).track_count == 2

    def test_finds_playlists_by_shape_not_filename(self):
        """Filenames vary across exports; structure is the reliable signal."""
        result = parse_spotify_export(_zip({"some_unexpected_name.json": PLAYLIST_DOC}))
        assert result.playlist_count == 1

    def test_ignores_non_json_members(self):
        result = parse_spotify_export(
            _zip({"Playlist1.json": PLAYLIST_DOC, "ReadMeFirst.pdf": "not json"})
        )
        assert result.source_files == ["Playlist1.json"]


class TestShapeTolerance:
    def test_accepts_snake_case_field_names(self):
        doc = {"playlists": [{"name": "P", "items": [
            {"track": {"track_name": "T", "artist_name": "A", "album_name": "Al"}}
        ]}]}
        track = parse_spotify_export(json.dumps(doc).encode()).playlists[0].tracks[0]
        assert (track.title, track.artist, track.album) == ("T", "A", "Al")

    def test_accepts_a_flat_track_shape(self):
        """The library export nests nothing; `track` is the title itself."""
        doc = {"playlists": [{"name": "P", "items": [
            {"track": "Bohemian Rhapsody", "artist": "Queen", "album": "A Night at the Opera"}
        ]}]}
        track = parse_spotify_export(json.dumps(doc).encode()).playlists[0].tracks[0]
        assert track.title == "Bohemian Rhapsody"
        assert track.artist == "Queen"

    def test_accepts_tracks_key_instead_of_items(self):
        doc = {"playlists": [{"name": "P", "tracks": [{"track": {"trackName": "T"}}]}]}
        assert parse_spotify_export(json.dumps(doc).encode()).track_count == 1

    def test_accepts_a_top_level_list(self):
        doc = [{"name": "P", "items": [{"track": {"trackName": "T"}}]}]
        assert parse_spotify_export(json.dumps(doc).encode()).playlist_count == 1

    def test_presents_saved_tracks_as_a_playlist(self):
        """Liked Songs has no playlist wrapper, but users think of it as one."""
        doc = {"tracks": [
            {"track": "Get Lucky", "artist": "Daft Punk", "album": "RAM"},
            {"track": "One More Time", "artist": "Daft Punk", "album": "Discovery"},
        ]}
        result = parse_spotify_export(json.dumps(doc).encode())
        assert result.playlists[0].name == DEFAULT_LIKED_NAME
        assert result.track_count == 2

    def test_liked_playlist_name_is_overridable(self):
        doc = {"tracks": [{"track": "T", "artist": "A"}]}
        result = parse_spotify_export(json.dumps(doc).encode(), liked_name="Me gustan")
        assert result.playlists[0].name == "Me gustan"

    def test_unnamed_playlist_gets_a_placeholder(self):
        doc = {"playlists": [{"items": [{"track": {"trackName": "T"}}]}]}
        assert parse_spotify_export(json.dumps(doc).encode()).playlists[0].name == "(unnamed playlist)"


class TestPartialFailure:
    def test_skips_entries_with_no_title_and_warns(self):
        doc = {"playlists": [{"name": "P", "items": [
            {"track": {"trackName": "Good", "artistName": "A"}},
            {"track": {"artistName": "Orphan with no title"}},
            "not even an object",
        ]}]}
        result = parse_spotify_export(json.dumps(doc).encode())

        assert result.track_count == 1
        assert any("skipped 2" in w for w in result.warnings)

    def test_one_corrupt_member_does_not_lose_the_others(self):
        data = _zip({"Playlist1.json": PLAYLIST_DOC, "Broken.json": "{not json"})
        result = parse_spotify_export(data)

        assert result.track_count == 2
        assert any("Broken.json" in w for w in result.warnings)

    def test_playlist_without_a_track_list_warns_rather_than_aborting(self):
        doc = {"playlists": [
            {"name": "Empty shell"},
            {"name": "Real", "items": [{"track": {"trackName": "T"}}]},
        ]}
        result = parse_spotify_export(json.dumps(doc).encode())

        assert result.playlist_count == 1
        assert any("Empty shell" in w for w in result.warnings)


class TestRejection:
    def test_empty_input_is_rejected(self):
        with pytest.raises(ValidationError):
            parse_spotify_export(b"")

    def test_missing_file_is_rejected(self, tmp_path):
        with pytest.raises(ValidationError, match="not found"):
            parse_spotify_export(tmp_path / "nope.zip")

    def test_export_with_no_playlists_is_rejected_with_guidance(self):
        """The message has to say what to download, or the user cannot act on it."""
        with pytest.raises(ValidationError, match="Account data"):
            parse_spotify_export(json.dumps({"identity": {"displayName": "x"}}).encode())

    def test_too_many_members_is_rejected(self):
        files = {f"f{i}.json": {"noise": i} for i in range(MAX_MEMBERS + 2)}
        with pytest.raises(ValidationError, match="over the"):
            parse_spotify_export(_zip(files))

    def test_decompression_bomb_is_rejected_before_reading(self):
        """A zip of highly compressible data must be caught on declared size."""
        bomb = _zip({"big.json": "A" * (300 * 1024 * 1024)})
        with pytest.raises(ValidationError, match="MB limit"):
            parse_spotify_export(bomb)


class TestExportedTrack:
    def test_search_query_prefers_artist_and_title(self):
        t = ExportedTrack(title="Get Lucky", artist="Daft Punk")
        assert t.search_query == "Daft Punk Get Lucky"

    def test_search_query_falls_back_to_title_alone(self):
        assert ExportedTrack(title="Get Lucky").search_query == "Get Lucky"

    def test_to_dict_is_camel_case_for_the_frontend(self):
        d = ExportedTrack(title="T", spotify_uri="spotify:track:x").to_dict()
        assert d["spotifyUri"] == "spotify:track:x"
        assert d["title"] == "T"


# --------------------------------------------------------------------- fixtures

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "spotify_export"


def _zip_fixture_dir(name: str, prefix: str = "") -> bytes:
    """Zip one of the fixture layouts exactly as Spotify ships it.

    `prefix` reproduces the folder real exports wrap everything in — which is
    `MyData/` in some and `Spotify Account Data/` in others, hence a parameter.
    """
    files = {}
    for path in sorted((FIXTURES / name).iterdir()):
        files[prefix + path.name] = path.read_bytes()
    return _zip(files)


class TestDocumentedExportLayouts:
    """The account-data export, reproduced from published real ones.

    These are synthetic in content and real in shape — see
    `tests/fixtures/spotify_export/README.md` for the evidence behind every
    layout, and for what to do the day a real export lands. They are the
    closest thing to a regression test that exists until then.
    """

    def test_reads_the_account_data_export(self):
        result = parse_spotify_export(_zip_fixture_dir("account_data", "MyData/"))

        names = [p.name for p in result.playlists]
        assert names == ["Rodada domingo", "Singalongs 2022", DEFAULT_LIKED_NAME]
        assert result.source_files == ["MyData/Playlist1.json", "MyData/YourLibrary.json"]

    def test_a_documented_layout_leaves_nothing_unrecognized(self):
        """An empty report means every archive member has a recognized disposition."""
        result = parse_spotify_export(_zip_fixture_dir("account_data", "MyData/"))
        assert result.unrecognized == []

    def test_the_2026_account_files_leave_nothing_unrecognized(self):
        """Recognize known non-playlist files and empty members without false warnings."""
        result = parse_spotify_export(
            _zip_fixture_dir("account_data_2026", "Spotify Account Data/"))

        assert result.unrecognized == []
        known = {m.filename.rsplit("/", 1)[-1] for m in result.unread if m.category == "known"}
        assert {"Follow.json", "MessageData.json", "Payments.json", "Wrapped2025.json"} <= known

    def test_the_other_account_files_are_named_not_flagged(self):
        result = parse_spotify_export(_zip_fixture_dir("account_data", "MyData/"))
        known = {m.filename.rsplit("/", 1)[-1]: m.detail for m in result.unread
                 if m.category == "known"}

        assert "StreamingHistory0.json" in known
        assert "play events" in known["StreamingHistory0.json"]
        assert "Userdata.json" in known and "Payments.json" in known

    def test_an_empty_library_is_not_treated_as_a_mystery(self):
        """An absent Liked Songs list is valid export data."""
        empty = {"tracks": [], "albums": [], "shows": [], "episodes": [],
                 "bannedTracks": [], "other": []}
        result = parse_spotify_export(_zip({"P.json": PLAYLIST_DOC, "YourLibrary.json": empty}))

        assert result.unrecognized == []
        assert any("YourLibrary" in m.detail for m in result.unread)

    def test_the_readme_pdf_is_ignored_on_purpose(self):
        result = parse_spotify_export(_zip_fixture_dir("account_data", "MyData/"))
        pdf = [m for m in result.unread if m.filename.endswith(".pdf")]

        assert [m.category for m in pdf] == ["ignored"]
        assert pdf[0].size_bytes > 0

    def test_podcast_and_audiobook_entries_are_skipped_as_such(self):
        """Not damage. A playlist with podcasts in it is not a broken playlist."""
        result = parse_spotify_export(_zip_fixture_dir("account_data"))

        assert any("podcast or audiobook" in w for w in result.warnings)
        assert not any("no title" in w for w in result.warnings)

    def test_a_local_file_in_a_playlist_survives(self):
        """`track` is null and the name lives only in the URI Spotify made up."""
        result = parse_spotify_export(_zip_fixture_dir("account_data"))
        titles = [t.title for t in result.playlists[0].tracks]

        assert "Bongo Bong" in titles
        assert "Don Poldon - Kosmokwachy" in titles

        local = next(t for t in result.playlists[0].tracks if t.title == "Bongo Bong")
        assert local.artist == "Manu Chao"
        assert local.album == "Clándestino"

    def test_saved_tracks_become_the_liked_songs_playlist(self):
        result = parse_spotify_export(_zip_fixture_dir("account_data"))
        liked = next(p for p in result.playlists if p.name == DEFAULT_LIKED_NAME)

        assert [t.title for t in liked.tracks] == ["Space Oddity - Demo", "Demons"]
        assert liked.tracks[0].artist == "David Bowie"

    def test_the_extended_streaming_history_export_is_named_in_the_error(self):
        """Requesting the wrong tier costs up to 30 days, so say which one it was."""
        with pytest.raises(ValidationError, match="Extended streaming history"):
            parse_spotify_export(_zip_fixture_dir("extended_streaming_history"))

    def test_streaming_history_is_never_imported_as_a_playlist(self):
        """Play events are not a track list; 4000 plays of one song are not 4000 songs."""
        history = (FIXTURES / "extended_streaming_history" /
                   "Streaming_History_Audio_2022-2024_0.json").read_bytes()
        data = _zip({"Playlist1.json": PLAYLIST_DOC, "Streaming_History_Audio_0.json": history})

        result = parse_spotify_export(data)

        assert result.track_count == 2
        assert [m.category for m in result.unread if m.filename.startswith("Streaming")] == ["known"]


class TestLocalTrackUris:
    """`spotify:local:<artist>:<album>:<title>:<seconds>`, percent+plus encoded."""

    def _title_of(self, uri):
        doc = {"playlists": [{"name": "P", "items": [
            {"track": None, "episode": None, "localTrack": {"uri": uri}}
        ]}]}
        result = parse_spotify_export(json.dumps(doc).encode())
        return result.playlists[0].tracks[0]

    def test_untagged_files_still_yield_a_title(self):
        track = self._title_of("spotify:local:::Some+File+Name:153")
        assert track.title == "Some File Name"
        assert track.artist is None and track.album is None

    def test_percent_escapes_are_decoded(self):
        assert self._title_of("spotify:local:::Caf%C3%A9+Tacvba:200").title == "Café Tacvba"

    def test_the_uri_is_kept_as_provenance_only(self):
        uri = "spotify:local:A:B:C:1"
        assert self._title_of(uri).spotify_uri == uri

    def test_a_malformed_local_uri_is_skipped_rather_than_guessed(self):
        doc = {"playlists": [{"name": "P", "items": [
            {"track": None, "localTrack": {"uri": "spotify:local:nonsense"}},
            {"track": {"trackName": "Real"}},
        ]}]}
        result = parse_spotify_export(json.dumps(doc).encode())
        assert [t.title for t in result.playlists[0].tracks] == ["Real"]

    def test_explicit_names_win_over_the_uri(self):
        """Should an export ever spell them out, believe it over the synthesised URI."""
        doc = {"playlists": [{"name": "P", "items": [{"track": None, "localTrack": {
            "trackName": "One More Time", "artistName": "Daft Punk", "albumName": "Discovery",
            "uri": "spotify:local:::wrong+name:320",
        }}]}]}
        parsed = parse_spotify_export(json.dumps(doc).encode()).playlists[0].tracks[0]
        assert (parsed.title, parsed.artist) == ("One More Time", "Daft Punk")


class TestUnreadMemberReport:
    """Report unfamiliar member shapes even when they produce no parse warning."""

    def test_json_it_cannot_interpret_is_reported_with_its_shape(self):
        mystery = {"deviceLog": [{"deviceId": "x", "lastSeen": "2026-01-01"}]}
        result = parse_spotify_export(_zip({"P.json": PLAYLIST_DOC, "Devices.json": mystery}))

        report = result.unrecognized
        assert [m.filename for m in report] == ["Devices.json"]
        assert "object with 1 keys" in report[0].detail and "deviceLog" in report[0].detail
        assert report[0].size_bytes > 0

    def test_an_array_document_reports_its_length_and_first_item(self):
        rows = [{"alpha": 1, "beta": 2} for _ in range(7)]
        result = parse_spotify_export(_zip({"P.json": PLAYLIST_DOC, "Rows.json": rows}))

        detail = result.unrecognized[0].detail
        assert "array of 7 items" in detail
        assert "first item keys: alpha, beta" in detail

    def test_the_report_never_leaks_values(self):
        """It gets pasted into bug reports; an export is somebody's private data."""
        secret = {"homeAddress": "Calle Falsa 123", "email": "someone@example.com"}
        result = parse_spotify_export(_zip({"P.json": PLAYLIST_DOC, "Weird.json": secret}))

        detail = result.unrecognized[0].detail
        assert "homeAddress" in detail
        assert "Calle Falsa" not in detail and "example.com" not in detail

    def test_long_shapes_are_truncated(self):
        wide = {f"field_{i}": i for i in range(40)}
        result = parse_spotify_export(_zip({"P.json": PLAYLIST_DOC, "Wide.json": wide}))

        detail = result.unrecognized[0].detail
        assert "(+28 more)" in detail
        assert len(detail) < 400

    def test_non_json_members_are_separated_from_json_we_failed_on(self):
        result = parse_spotify_export(
            _zip({"P.json": PLAYLIST_DOC, "Read_Me_First.pdf": "x", "cover.png": "y"})
        )
        categories = {m.filename: m.category for m in result.unread}

        assert categories == {"Read_Me_First.pdf": "ignored", "cover.png": "ignored"}
        assert result.unrecognized == []

    def test_macos_resource_forks_are_not_reported_as_corruption(self):
        """A re-zipped export carries AppleDouble sidecars the user cannot see."""
        result = parse_spotify_export(_zip({
            "P.json": PLAYLIST_DOC,
            "__MACOSX/._P.json": b"\x00\x05\x16\x07binary",
        }))

        assert [m.category for m in result.unread] == ["ignored"]
        assert not any("UTF-8" in w for w in result.warnings)

    def test_undecodable_json_is_reported_as_unreadable_not_unknown(self):
        result = parse_spotify_export(_zip({"P.json": PLAYLIST_DOC, "Broken.json": "{not json"}))
        broken = next(m for m in result.unread if m.filename == "Broken.json")

        assert broken.category == "unreadable"
        assert result.unrecognized == []

    def test_the_report_reaches_the_frontend(self):
        result = parse_spotify_export(_zip({"P.json": PLAYLIST_DOC, "X.json": {"weird": 1}}))
        payload = result.to_dict()

        assert payload["unrecognizedCount"] == 1
        member = next(m for m in payload["unreadMembers"] if m["filename"] == "X.json")
        assert member["category"] == "unrecognized"
        assert set(member) == {"filename", "sizeBytes", "category", "detail"}

    def test_a_rejected_export_carries_the_report_in_its_details(self):
        """The failing case is exactly when someone needs to know what was in there."""
        with pytest.raises(ValidationError) as excinfo:
            parse_spotify_export(_zip({"Mystery.json": {"nothing": "useful"}}))

        details = excinfo.value.details
        assert [m["filename"] for m in details["unreadMembers"]] == ["Mystery.json"]
