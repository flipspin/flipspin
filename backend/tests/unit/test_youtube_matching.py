"""Check upload-title cleanup without losing recording qualifiers.

Live, remix, instrumental, and duration differences remain meaningful even
when promotional title text is removed.
"""
import time

import pytest

from app.domains.downloads.youtube_matching import (
    clean_video_title,
    select_video,
    uploader_artist,
    source_candidate,
)
from app.domains.metadata.matching import WantedTrack


def yt(title, url="https://www.youtube.com/watch?v=aaaaaaaaaaa", duration=None,
       uploader=None, vid=None):
    """One yt-dlp --flat-playlist search result."""
    return {"title": title, "url": url, "duration": duration,
            "artist": uploader, "id": vid}


class TestCleanVideoTitle:
    @pytest.mark.parametrize("raw,gone", [
        ("Daft Punk - Get Lucky (Official Video)", "official"),
        ("Daft Punk - Get Lucky [Official Music Video]", "official"),
        ("Daft Punk - Get Lucky (Official Audio)", "official"),
        ("Daft Punk - Get Lucky (Official Lyric Video)", "lyric"),
        ("Daft Punk - Get Lucky [HD]", "hd"),
        ("Daft Punk - Get Lucky [4K]", "4k"),
        ("Daft Punk - Get Lucky (Visualizer)", "visualizer"),
        ("Daft Punk Get Lucky Official Audio 4K", "official"),
        ("AC/DC - Thunderstruck (Official 4K Video)", "video"),
        ("Bad Bunny - Titi Me Pregunto (Video Oficial)", "oficial"),
        ("Shakira - Antologia (Letra)", "letra"),
    ])
    def test_removes_upload_furniture(self, raw, gone):
        assert gone not in clean_video_title(raw).lower()

    @pytest.mark.parametrize("raw,kept", [
        ("Queen - Bohemian Rhapsody (Live at Wembley)", "live"),
        ("Daft Punk - Get Lucky (Nightcore Remix)", "remix"),
        ("Adele - Hello (Instrumental)", "instrumental"),
        ("Adele - Hello (Karaoke Version)", "karaoke"),
        ("Nirvana - The Man Who Sold the World (Acoustic)", "acoustic"),
        ("Daft Punk - Get Lucky (Radio Edit)", "radio edit"),
    ])
    def test_keeps_markers_that_name_a_different_recording(self, raw, kept):
        """The whole point: these have to reach the matcher's qualifier veto."""
        assert kept in clean_video_title(raw).lower()

    def test_keeps_furniture_that_shares_a_bracket_with_a_qualifier(self):
        cleaned = clean_video_title("Queen - Bohemian Rhapsody (Live Official Video)")
        assert "live" in cleaned.lower()

    def test_drops_a_branding_pipe_tail(self):
        assert "vevo" not in clean_video_title("Get Lucky | DaftPunkVEVO").lower()

    def test_keeps_a_pipe_tail_carrying_a_qualifier(self):
        assert "live" in clean_video_title("Bohemian Rhapsody | Live Aid 1985").lower()

    def test_does_not_eat_a_leading_word_that_is_also_furniture(self):
        """Trailing-only removal — "Audio Video Disco" must survive."""
        assert clean_video_title("Justice - Audio Video Disco").endswith("Audio Video Disco")

    def test_a_song_named_after_furniture_survives(self):
        """Bare "video" is only peeled off the tail, never out of the middle."""
        raw = "The Buggles - Video Killed the Radio Star (Official Video)"
        assert clean_video_title(raw) == "The Buggles - Video Killed the Radio Star"

    def test_a_remaster_marker_is_left_for_the_shared_normalizer(self):
        """`strip_noise` already merges remasters; duplicating it here would drift."""
        cleaned = clean_video_title("Queen - Bohemian Rhapsody (Official Video Remastered)")
        assert "Remastered" in cleaned

    def test_a_furniture_heavy_title_does_not_blow_up_the_regex(self):
        """Guards the ReDoS shape a "(furniture)+$" pattern would have here."""
        started = time.perf_counter()
        clean_video_title("(" + "official video " * 400 + "x)")
        assert time.perf_counter() - started < 1.0

    def test_empty_input(self):
        assert clean_video_title("") == ""


class TestUploaderAndId:
    @pytest.mark.parametrize("uploader,expected", [
        ("Daft Punk - Topic", "Daft Punk"),
        ("DaftPunkVEVO", "DaftPunk"),
        ("Some Random Channel", "Some Random Channel"),
        (None, None),
    ])
    def test_uploader_artist(self, uploader, expected):
        assert uploader_artist(uploader) == expected



class TestCandidateBuilding:
    def test_splits_artist_and_title_on_the_dash(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        cand = source_candidate(yt("Daft Punk - Get Lucky (Official Video)"), wanted)
        assert cand.title == "Get Lucky"
        assert cand.artist == "Daft Punk"
        assert cand.provider == "youtube"

    def test_handles_the_reversed_convention(self):
        """"Get Lucky - Daft Punk | Lyrics" is just as common as the other order."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        cand = source_candidate(yt("Get Lucky - Daft Punk | Lyrics"), wanted)
        assert cand.title == "Get Lucky"
        assert cand.artist == "Daft Punk"

    def test_recovers_a_split_when_the_uploader_used_no_separator(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        cand = source_candidate(yt("Daft Punk Get Lucky Official Audio 4K"), wanted)
        assert cand.title == "Get Lucky"
        assert cand.artist == "Daft Punk"

    def test_falls_back_to_the_channel_for_the_artist(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        cand = source_candidate(yt("Get Lucky", uploader="Daft Punk - Topic"), wanted)
        assert cand.artist == "Daft Punk"

    def test_carries_duration_and_video_id(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        cand = source_candidate(
            yt("Daft Punk - Get Lucky", url="https://youtu.be/5NV6Rdv1a3I", duration=369),
            wanted,
        )
        assert cand.duration_s == 369.0
        assert cand.provider_id == "https://youtu.be/5NV6Rdv1a3I"

    def test_a_source_candidate_is_never_identifiable(self):
        """No ISRC/MBID on YouTube — which is why select_video accepts REVIEW."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        assert not source_candidate(yt("Daft Punk - Get Lucky"), wanted).is_identifiable

    def test_result_without_a_title_or_url_is_skipped(self):
        wanted = WantedTrack(title="Get Lucky")
        assert source_candidate({"title": "", "url": "x"}, wanted) is None
        assert source_candidate({"title": "Get Lucky", "url": None}, wanted) is None

    def test_free_text_query_is_not_split(self):
        """No wanted artist means no way to know which half is which."""
        wanted = WantedTrack(title="daft punk get lucky")
        cand = source_candidate(yt("Daft Punk - Get Lucky (Official Video)"), wanted)
        assert cand.artist is None
        assert "Daft Punk" in cand.title and "Get Lucky" in cand.title


class TestSelection:
    def test_picks_the_official_video_for_a_studio_request(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=369.0)
        choice = select_video(wanted, [
            yt("Daft Punk - Get Lucky (Official Video)",
               url="https://youtu.be/good", duration=369),
        ])
        assert choice.accepted
        assert choice.url == "https://youtu.be/good"

    def test_live_upload_does_not_satisfy_a_studio_request(self):
        wanted = WantedTrack(title="Bohemian Rhapsody", artist="Queen", duration_s=354.0)
        choice = select_video(wanted, [
            yt("Queen - Bohemian Rhapsody (Live at Wembley Stadium)",
               url="https://youtu.be/live", duration=352),
        ])
        assert not choice.accepted
        assert "live" in choice.reason.lower()

    def test_ten_minute_extended_mix_is_vetoed_on_duration(self):
        """Perfect title, wrong recording — only the duration says so."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=369.0)
        choice = select_video(wanted, [
            yt("Daft Punk - Get Lucky", url="https://youtu.be/extended", duration=600),
        ])
        assert not choice.accepted
        assert "duration" in choice.reason.lower()

    def test_studio_version_wins_over_a_longer_upload_of_the_same_song(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=369.0)
        choice = select_video(wanted, [
            yt("Daft Punk - Get Lucky", url="https://youtu.be/extended", duration=620),
            yt("Daft Punk - Get Lucky (Official Video)",
               url="https://youtu.be/studio", duration=369),
        ])
        assert choice.url == "https://youtu.be/studio"

    def test_an_instrumental_request_can_finally_be_satisfied(self):
        """The old filter dropped every title containing "instrumental"."""
        wanted = WantedTrack(title="Hello (Instrumental)", artist="Adele", duration_s=295.0)
        choice = select_video(wanted, [
            yt("Adele - Hello (Official Video)", url="https://youtu.be/vocal", duration=295),
            yt("Adele - Hello (Instrumental)", url="https://youtu.be/instrumental", duration=295),
        ])
        assert choice.accepted
        assert choice.url == "https://youtu.be/instrumental"

    def test_a_studio_take_does_not_satisfy_an_instrumental_request(self):
        wanted = WantedTrack(title="Hello (Instrumental)", artist="Adele", duration_s=295.0)
        choice = select_video(wanted, [
            yt("Adele - Hello (Official Video)", url="https://youtu.be/vocal", duration=295),
        ])
        assert not choice.accepted

    def test_an_unrelated_result_is_refused_rather_than_downloaded(self):
        """The behaviour change: no match now means no file, with a reason."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        choice = select_video(wanted, [
            yt("Luis Fonsi - Despacito ft. Daddy Yankee", url="https://youtu.be/nope"),
        ])
        assert not choice.accepted
        assert choice.reason

    def test_karaoke_upload_is_refused_for_a_plain_request(self):
        wanted = WantedTrack(title="Hello", artist="Adele")
        choice = select_video(wanted, [
            yt("Adele - Hello (Karaoke Version)", url="https://youtu.be/kar"),
        ])
        assert not choice.accepted

    def test_two_uploads_of_the_same_recording_are_both_acceptable(self):
        """Unidentifiable + too-close-to-call is still a download, not a refusal."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=369.0)
        choice = select_video(wanted, [
            yt("Daft Punk - Get Lucky (Official Video)", url="https://youtu.be/a", duration=369),
            yt("Daft Punk - Get Lucky (Official Audio)", url="https://youtu.be/b", duration=370),
        ])
        assert choice.accepted
        assert choice.url in {"https://youtu.be/a", "https://youtu.be/b"}

    def test_free_text_query_still_resolves(self):
        wanted = WantedTrack(title="daft punk get lucky")
        choice = select_video(wanted, [
            yt("Daft Punk - Get Lucky (Official Video)", url="https://youtu.be/ok"),
        ])
        assert choice.url == "https://youtu.be/ok"

    def test_free_text_query_naming_only_the_song_still_resolves(self):
        wanted = WantedTrack(title="Get Lucky")
        choice = select_video(wanted, [
            yt("Daft Punk - Get Lucky (Official Video)", url="https://youtu.be/ok"),
        ])
        assert choice.url == "https://youtu.be/ok"

    def test_free_text_query_still_respects_the_qualifier_veto(self):
        wanted = WantedTrack(title="Get Lucky")
        choice = select_video(wanted, [
            yt("Daft Punk - Get Lucky (Live at Coachella)", url="https://youtu.be/live"),
        ])
        assert not choice.accepted

    def test_missing_duration_is_not_faked(self):
        """No Spotify duration is a normal state, not a reason to refuse."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        choice = select_video(wanted, [
            yt("Daft Punk - Get Lucky (Official Video)", url="https://youtu.be/ok"),
        ])
        assert choice.accepted
        assert "no duration to compare" in choice.match.best.reasons

    def test_empty_results_are_refused_with_a_reason(self):
        choice = select_video(WantedTrack(title="Get Lucky"), [])
        assert not choice.accepted
        assert choice.reason
