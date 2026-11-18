"""The lyrics domain: sidecar + index, ranking, the lock, and the library pass.

Everything runs against a tmp library with real files, because the whole
feature is "a file beside the song": a fake filesystem would let a wrong
suffix, a missing rename or a stale sibling sidecar pass unnoticed.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.infra.progress import ProgressTracker
from app.domains.lyrics.lrclib_repository import LrclibRepository
from app.exceptions import ValidationError
from app.domains.lyrics.models import (
    KIND_INSTRUMENTAL,
    KIND_PLAIN,
    KIND_SYNCED,
    LyricsCandidate,
    LyricsQuery,
)
from app.domains.lyrics.repositories import LyricsRepository
from app.domains.lyrics.services import LyricsLockedError, LyricsNotFoundError, LyricsSearchUnavailable, LyricsService
from app.providers.registry import ProviderDescriptor, ProviderKind, ProviderRegistry

pytestmark = pytest.mark.unit
LOG = logging.getLogger("test.lyrics")

LRC = "[00:12.40] Le café brûlé refroidit sur la table\n[00:17.90] Et le chat s'endort\n"
PLAIN = "Le café brûlé refroidit sur la table\nEt le chat s'endort\n"


# ------------------------------------------------------------------ fakes


def _track(path: Path, title, artist="Stromae", album="Multitude", duration=187.0):
    return SimpleNamespace(
        title=title, artist=artist, album=album, duration=duration, track_number=1, path=path
    )


class FakeMusicRepo:
    def __init__(self, base: Path, tracks: list[SimpleNamespace]):
        self.base = base
        self.tracks = tracks

    def scan_albums(self):
        by_album = {}
        for t in self.tracks:
            by_album.setdefault(t.album, []).append(t)
        return [SimpleNamespace(name=name, tracks=ts) for name, ts in by_album.items()]

    def get_track_info(self, path: Path):
        for t in self.tracks:
            if Path(t.path) == path:
                return t
        return SimpleNamespace(title=path.stem, artist="", album=path.parent.name, duration=None)


class FakeCatalog:
    """A lyrics provider whose answers the test scripts."""

    def __init__(self, answers=None, fail=False):
        self.answers = answers or {}
        self.fail = fail
        self.queries: list[LyricsQuery] = []

    def search_lyrics(self, query: LyricsQuery):
        self.queries.append(query)
        if self.fail:
            raise RuntimeError("catalog down")
        return list(self.answers.get(query.title, []))


def _registry(*providers):
    registry = ProviderRegistry(store=None)
    for pid, instance in providers:
        registry.register(
            ProviderDescriptor(
                id=pid, kind=ProviderKind.LYRICS, name=pid, description="", capabilities=("lyrics",)
            ),
            instance,
        )
    return registry


def _candidate(provider="lrclib", synced=LRC, plain=None, duration=187.0, title="Tête brûlée",
               artist="Stromae", instrumental=False, ref="lrclib:1"):
    return LyricsCandidate(
        provider=provider, title=title, artist=artist, album="Multitude", duration_s=duration,
        synced_lyrics=synced, plain_lyrics=plain, instrumental=instrumental, provider_ref=ref,
    )


@pytest.fixture
def library(tmp_path):
    music = tmp_path / "Music"
    (music / "Multitude").mkdir(parents=True)
    song = music / "Multitude" / "Tete_brulee.mp3"
    song.write_bytes(b"ID3")
    config = SimpleNamespace(
        base_music_dir=music,
        lyrics_file=tmp_path / "lyrics.json",
        lyrics_auto_fetch=False,
    )
    tracks = [_track(song, "Tête brûlée")]
    return SimpleNamespace(config=config, music=music, song=song, tracks=tracks)


def _service(library, *providers, sleep=lambda s: None):
    repo = LyricsRepository(library.config, LOG)
    return LyricsService(
        repository=repo,
        music_repository=FakeMusicRepo(library.music, library.tracks),
        registry=_registry(*providers),
        progress_tracker=ProgressTracker(),
        config=library.config,
        logger=LOG,
        sleep=sleep,
    )


def _wait_idle(service: LyricsService, timeout=5.0):
    worker = service._worker
    deadline = threading.Event()
    for _ in range(int(timeout * 100)):
        with service._queue_lock:
            done = not service._queue and service._current is None and not service._batches
        if done:
            return
        deadline.wait(0.01)
    raise AssertionError(f"lyrics worker did not drain (thread alive: {worker and worker.is_alive()})")


@pytest.mark.parametrize("system,machine,forced,expected", [
    ("Linux", "x86_64", "auto", "agent"),
    ("Darwin", "arm64", "auto", "local"),
    ("Darwin", "x86_64", "auto", "agent"),
    ("Windows", "AMD64", "auto", "agent"),
    ("Linux", "x86_64", "local", "local"),
    ("Darwin", "arm64", "agent", "agent"),
])
def test_auto_placement_is_independent_of_install_support_and_stems_matches(
    library, monkeypatch, system, machine, forced, expected,
):
    from unittest.mock import Mock
    from app.domains.stems.repositories import StemsRepository
    from app.domains.stems.services import StemsService

    monkeypatch.setattr("app.domains.lyrics.services.platform.system", lambda: system)
    monkeypatch.setattr("app.domains.lyrics.services.platform.machine", lambda: machine)
    library.config.lyrics_engine_mode = forced
    library.config.stems_dir = library.music.parent / "stems"
    service = _service(library)
    assert service.engine_mode == expected
    if system == "Linux":
        assert service.engine.supported  # install gate stays widened.
    monkeypatch.setattr(service.engine, "run", Mock(return_value="local-batch"))
    service.transcribe([("Multitude/Tete_brulee.mp3", None)])
    assert service.engine.run.called == (expected == "local")
    assert service.agent_queue.status()["queued"] == (1 if expected == "agent" else 0)
    stems = StemsService(repository=StemsRepository(library.config, LOG), config=library.config,
                         logger=LOG, engine=SimpleNamespace(installed=True, check=lambda: {"addons": {"stems": {"ready": True}}}),
                         engine_mode=lambda: service.engine_mode)
    monkeypatch.setattr(stems.runner, "kick", Mock())
    stems.request("Multitude", "Tete_brulee.mp3")
    assert stems.jobs()["mode"] == expected
    assert stems.runner.kick.called == (expected == "local")


# --------------------------------------------------------------- sidecars


class TestSidecarIsTheContract:
    def test_a_synced_lyric_lands_as_lrc_beside_the_song(self, library):
        service = _service(library)
        doc = service.save("Multitude/Tete_brulee.mp3", kind=KIND_SYNCED, text=LRC, source="lrclib")
        sidecar = library.song.with_suffix(".lrc")
        assert sidecar.read_text(encoding="utf-8") == LRC
        assert doc.record.sidecar == "Tete_brulee.lrc"
        assert service.get("Multitude/Tete_brulee.mp3").text == LRC

    def test_a_plain_lyric_is_txt_not_a_fake_lrc(self, library):
        service = _service(library)
        service.save("Multitude/Tete_brulee.mp3", kind=KIND_PLAIN, text=PLAIN, source="genius")
        assert library.song.with_suffix(".txt").exists()
        assert not library.song.with_suffix(".lrc").exists()

    def test_replacing_plain_with_synced_removes_the_stale_sibling(self, library):
        service = _service(library)
        rel = "Multitude/Tete_brulee.mp3"
        service.save(rel, kind=KIND_PLAIN, text=PLAIN, source="genius")
        service.save(rel, kind=KIND_SYNCED, text=LRC, source="lrclib")
        assert library.song.with_suffix(".lrc").exists()
        assert not library.song.with_suffix(".txt").exists()

    def test_an_lrc_already_on_disk_is_adopted_not_refetched(self, library):
        library.song.with_suffix(".lrc").write_text(LRC, encoding="utf-8")
        catalog = FakeCatalog({"Tête brûlée": [_candidate()]})
        service = _service(library, ("lrclib", catalog))
        doc = service.get("Multitude/Tete_brulee.mp3")
        assert doc is not None and doc.record.source == "file" and doc.text == LRC
        service.start_scan()
        _wait_idle(service)
        assert catalog.queries == []

    def test_an_instrumental_verdict_writes_no_file_but_is_remembered(self, library):
        service = _service(library)
        rel = "Multitude/Tete_brulee.mp3"
        service.save(rel, kind=KIND_INSTRUMENTAL, text="", source="lrclib")
        assert not library.song.with_suffix(".lrc").exists()
        assert service.get(rel).record.kind == KIND_INSTRUMENTAL
        assert rel not in [p.rel_path for p in service.repository.pending()]

    def test_a_sidecar_deleted_by_hand_drops_the_stale_index_row(self, library):
        service = _service(library)
        rel = "Multitude/Tete_brulee.mp3"
        service.save(rel, kind=KIND_SYNCED, text=LRC, source="lrclib")
        library.song.with_suffix(".lrc").unlink()
        assert service.get(rel) is None
        assert service.repository.get_record(rel) is None

    def test_unknown_song_is_not_found_and_a_traversal_is_refused(self, library):
        service = _service(library)
        with pytest.raises(LyricsNotFoundError):
            service.get("Multitude/nope.mp3")
        with pytest.raises(ValidationError):
            service.get("../etc/passwd")

    def test_delete_removes_row_and_files(self, library):
        service = _service(library)
        rel = "Multitude/Tete_brulee.mp3"
        service.save(rel, kind=KIND_SYNCED, text=LRC, source="lrclib")
        assert service.delete(rel) is True
        assert not library.song.with_suffix(".lrc").exists()
        assert service.get(rel) is None


# ------------------------------------------------------------------ lock


class TestTheEditedLock:
    def test_an_edited_lyric_refuses_an_automatic_overwrite(self, library):
        service = _service(library)
        rel = "Multitude/Tete_brulee.mp3"
        service.save(rel, kind=KIND_SYNCED, text=LRC, source="manual", edited=True)
        with pytest.raises(LyricsLockedError):
            service.save(rel, kind=KIND_SYNCED, text="[00:01.00] wrong\n", source="lrclib")
        assert service.get(rel).text == LRC

    def test_force_from_a_person_replaces_it_and_clears_the_lock(self, library):
        service = _service(library)
        rel = "Multitude/Tete_brulee.mp3"
        service.save(rel, kind=KIND_SYNCED, text=LRC, source="manual", edited=True)
        doc = service.save(rel, kind=KIND_SYNCED, text="[00:01.00] new\n", source="lrclib", force=True)
        assert doc.record.edited is False
        assert doc.text.startswith("[00:01.00] new")

    def test_the_pass_skips_an_edited_song(self, library):
        catalog = FakeCatalog({"Tête brûlée": [_candidate()]})
        service = _service(library, ("lrclib", catalog))
        rel = "Multitude/Tete_brulee.mp3"
        service.save(rel, kind=KIND_PLAIN, text="mine\n", source="manual", edited=True)
        service.start_scan()
        _wait_idle(service)
        assert catalog.queries == []
        assert service.get(rel).text == "mine\n"


# --------------------------------------------------------------- ranking


class TestRanking:
    def test_synced_in_tolerance_beats_plain_beats_near_miss(self):
        q = LyricsQuery("Tête brûlée", "Stromae", "Multitude", 187.0)
        near = _candidate(duration=203.0, ref="lrclib:far")
        plain = _candidate(provider="genius", synced=None, plain=PLAIN, duration=None, ref="genius:1")
        exact = _candidate(ref="lrclib:exact")
        for c in (near, plain, exact):
            if c.duration_s is not None:
                c.duration_delta_s = c.duration_s - q.duration_s
        ranked = LyricsService.rank([near, plain, exact], q)
        assert [c.provider_ref for c in ranked] == ["lrclib:exact", "genius:1", "lrclib:far"]

    def test_the_pass_only_defends_a_same_key_hit_inside_tolerance(self):
        q = LyricsQuery("Tête brûlée", "Stromae", "Multitude", 187.0)
        good = _candidate(); good.duration_delta_s = 1.0
        other_artist = _candidate(artist="Someone Else"); other_artist.duration_delta_s = 0.0
        too_long = _candidate(); too_long.duration_delta_s = 9.0
        plain_no_duration = _candidate(provider="genius", synced=None, plain=PLAIN, duration=None)
        assert LyricsService.defensible(good, q)
        assert not LyricsService.defensible(other_artist, q)
        assert not LyricsService.defensible(too_long, q)
        assert LyricsService.defensible(plain_no_duration, q)

    def test_a_lyric_that_outlives_the_file_is_vetoed_even_without_a_duration(self, library):
        # LRCLIB rows sometimes carry duration: null. The last stamp still says
        # the song is at least 3:16 long; the local file is 3:07.
        long = _candidate(duration=None, synced="[00:10.00] a\n[03:16.00] b\n", ref="lrclib:long")
        fits = _candidate(duration=None, synced="[00:10.00] a\n[02:59.00] b\n", ref="lrclib:fits")
        catalog = FakeCatalog({"Tête brûlée": [long, fits]})
        service = _service(library, ("lrclib", catalog))
        _, candidates = service.search("Multitude/Tete_brulee.mp3")
        assert [c.provider_ref for c in candidates] == ["lrclib:fits", "lrclib:long"]
        assert candidates[1].within_tolerance is False and candidates[1].overrun_s == 9.0
        q = LyricsQuery("Tête brûlée", "Stromae", "Multitude", 187.0)
        assert LyricsService.defensible(candidates[0], q)
        assert not LyricsService.defensible(candidates[1], q)

    def test_every_enabled_catalog_is_asked_and_a_dead_one_is_survived(self, library):
        dead = FakeCatalog(fail=True)
        alive = FakeCatalog({"Tête brûlée": [_candidate()]})
        service = _service(library, ("lrclib", dead), ("genius", alive))
        query, candidates = service.search("Multitude/Tete_brulee.mp3")
        assert query.duration_s == 187.0
        assert [c.provider_ref for c in candidates] == ["lrclib:1"]
        assert dead.queries and alive.queries


# -------------------------------------------------------------- the pass


class TestTheLibraryPass:
    def test_a_pass_files_hits_and_records_misses_as_pending(self, library):
        other = library.music / "Multitude" / "Unknown.mp3"
        other.write_bytes(b"ID3")
        library.tracks.append(_track(other, "Nobody Has This", duration=200.0))
        catalog = FakeCatalog({"Tête brûlée": [_candidate()]})
        service = _service(library, ("lrclib", catalog))

        summary = service.start_scan()
        assert summary.total == 2
        _wait_idle(service)

        assert library.song.with_suffix(".lrc").exists()
        pending = service.repository.pending()
        assert [p.rel_path for p in pending] == ["Multitude/Unknown.mp3"]
        state = service.progress_tracker.get_progress(summary.progress_id)
        assert state.is_terminal and state.succeeded == 1 and state.failed == 1
        jobs = service.jobs()
        assert jobs["withLyrics"] == 1 and jobs["pendingCount"] == 1 and jobs["running"] is None

    def test_a_second_pass_while_one_runs_is_refused(self, library):
        blocker = threading.Event()

        class Slow(FakeCatalog):
            def search_lyrics(self, query):
                blocker.wait(2)
                return []

        service = _service(library, ("lrclib", Slow()))
        first = service.start_scan()
        assert first is not None
        assert service.start_scan() is None
        blocker.set()
        _wait_idle(service)

    def test_acquired_files_are_only_queued_when_auto_fetch_is_on(self, library):
        catalog = FakeCatalog({"Tête brûlée": [_candidate()]})
        service = _service(library, ("lrclib", catalog))
        assert service.enqueue_files([library.song]) is None
        library.config.lyrics_auto_fetch = True
        summary = service.enqueue_files([library.song, library.song])
        assert summary.total == 1
        _wait_idle(service)
        assert library.song.with_suffix(".lrc").exists()

    def test_a_pending_song_is_retried_by_the_next_pass(self, library):
        catalog = FakeCatalog({})
        service = _service(library, ("lrclib", catalog))
        service.start_scan()
        _wait_idle(service)
        assert service.repository.pending()
        catalog.answers = {"Tête brûlée": [_candidate()]}
        service.start_scan()
        _wait_idle(service)
        assert not service.repository.pending()
        assert library.song.with_suffix(".lrc").exists()


# ---------------------------------------------------------------- lrclib


class _Response:
    def __init__(self, status, payload=None, headers=None):
        self.status_code = status
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _Session:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers))
        return self.script.pop(0)


ROW = {
    "id": 3396226, "trackName": "Tête brûlée", "artistName": "Stromae", "albumName": "Multitude",
    "duration": 187, "instrumental": False, "plainLyrics": PLAIN, "syncedLyrics": LRC,
}


class TestLrclibRepository:
    def _repo(self, script, sleeps=None):
        config = SimpleNamespace(musicbrainz_contact="test@example.com")
        return LrclibRepository(
            config, LOG, session=_Session(script), sleep=(sleeps.append if sleeps is not None else lambda s: None),
            min_interval_s=1.0,
        )

    def test_exact_signature_then_search_and_a_descriptive_user_agent(self):
        repo = self._repo([_Response(404), _Response(200, [ROW])])
        q = LyricsQuery("Tête brûlée", "Stromae", "Multitude", 187.3)
        assert repo.get_exact(q) is None
        rows = repo.search(q)
        assert rows[0].provider_ref == "lrclib:3396226" and rows[0].synced_lyrics == LRC.strip()
        get_url, get_params, headers = repo.session.calls[0]
        assert get_url.endswith("/get") and get_params["duration"] == 187
        assert headers["User-Agent"].startswith("Flipspin/") and "test@example.com" in headers["User-Agent"]
        assert repo.session.calls[1][0].endswith("/search")

    def test_no_album_skips_the_exact_call(self):
        repo = self._repo([])
        assert repo.get_exact(LyricsQuery("x", "y", "", 100.0)) is None
        assert repo.session.calls == []

    def test_requests_are_paced_one_per_second(self):
        sleeps = []
        repo = self._repo([_Response(200, [ROW]), _Response(200, [ROW])], sleeps)
        q = LyricsQuery("Tête brûlée", "Stromae")
        repo.search(q)
        repo.search(LyricsQuery("Another song", "Stromae"))
        assert sleeps and 0 < sleeps[0] <= 1.0

    def test_429_waits_retry_after_then_retries_once(self):
        sleeps = []
        repo = self._repo([_Response(429, headers={"Retry-After": "3"}), _Response(200, [ROW])], sleeps)
        rows = repo.search(LyricsQuery("Tête brûlée", "Stromae"))
        assert len(rows) == 1 and 3.0 in sleeps

    def test_an_instrumental_row_is_a_candidate_with_no_text(self):
        repo = self._repo([_Response(200, [{**ROW, "syncedLyrics": "", "plainLyrics": "", "instrumental": True}])])
        rows = repo.search(LyricsQuery("Tête brûlée", "Stromae"))
        assert rows[0].instrumental and rows[0].kind == KIND_INSTRUMENTAL


# ------------------------------------------------------- aligning known text


class TestAligningAKnownText:
    """"Sync": a plain lyric goes to the Mac aligner and comes back synced,
    scored line by line. Agent mode, because that is how the nest runs it."""

    @pytest.fixture
    def agent_service(self, library):
        library.config.lyrics_engine_mode = "agent"
        return _service(library)

    def _process(self, service, extra):
        claimed = service.agent_queue.claim({"name": "mac", "version": "0.10.0"}, max_jobs=1)
        job = claimed["jobs"][0]
        service.agent_queue.result(claimed["lease"], job["id"], ok=True, lrc=LRC, source="aligned:mms-fa", extra=extra)
        return job

    def test_the_plain_lyric_on_disk_is_the_text_and_the_score_is_kept(self, agent_service):
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.save(rel, kind=KIND_PLAIN, text=PLAIN, source="genius")
        agent_service.transcribe([(rel, None)])
        job = self._process(agent_service, {"lineConfidence": [0.81, 0.09], "lowLines": [1]})
        assert job["text"] == PLAIN
        assert job["vocalsPath"] is None  # no split of this song
        doc = agent_service.get(rel)
        assert doc.record.kind == KIND_SYNCED and doc.text == LRC
        assert doc.record.line_confidence == [0.81, 0.09] and doc.record.low_lines == [1]
        assert doc.to_dict()["lowLines"] == [1]

    def test_a_hand_written_plain_lyric_can_be_synced_and_stays_locked(self, agent_service):
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.save(rel, kind=KIND_PLAIN, text=PLAIN, source="manual", edited=True)
        agent_service.transcribe([(rel, None)])
        self._process(agent_service, {"lineConfidence": [0.5, 0.5], "lowLines": []})
        record = agent_service.get(rel).record
        assert record.kind == KIND_SYNCED and record.edited is True

    def test_an_edited_synced_lyric_is_never_queued(self, agent_service):
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.save(rel, kind=KIND_SYNCED, text=LRC, source="manual", edited=True)
        with pytest.raises(ValueError):
            agent_service.transcribe([(rel, None)])

    @pytest.mark.parametrize("kind,text", [(KIND_PLAIN, PLAIN), (KIND_SYNCED, LRC)])
    def test_explicit_same_words_can_retime_a_manual_lyric(self, agent_service, kind, text):
        from app.domains.lyrics.models import lyrics_words
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.save(rel, kind=kind, text=text, source="manual", edited=True)
        agent_service.transcribe([(rel, lyrics_words(text))])
        self._process(agent_service, {"lowLines": [1]})
        doc = agent_service.get(rel)
        assert doc.record.kind == KIND_SYNCED and doc.record.edited
        assert doc.record.low_lines == [1]

    def test_different_words_cannot_replace_a_manual_lyric(self, agent_service):
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.save(rel, kind=KIND_SYNCED, text=LRC, source="manual", edited=True)
        with pytest.raises(ValueError):
            agent_service.transcribe([(rel, "Different words")])

    def test_changes_during_alignment_are_preserved(self, agent_service):
        from app.domains.lyrics.models import lyrics_words
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.save(rel, kind=KIND_SYNCED, text=LRC, source="manual", edited=True)
        agent_service.transcribe([(rel, lyrics_words(LRC))])
        changed = "[00:03]A new correction"
        agent_service.save(rel, kind=KIND_SYNCED, text=changed, source="manual", edited=True, force=True)
        self._process(agent_service, {})
        assert agent_service.get(rel).text == changed + "\n"

    def test_local_engine_keeps_the_same_snapshot_guard(self, agent_service, monkeypatch, tmp_path):
        from app.domains.lyrics.models import lyrics_words
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.config.lyrics_engine_mode = "local"
        agent_service.save(rel, kind=KIND_SYNCED, text=LRC, source="manual", edited=True)
        jobs = []
        monkeypatch.setattr(agent_service.engine, "run", lambda batch: jobs.extend(batch) or "local-run")
        agent_service.transcribe([(rel, lyrics_words(LRC))])
        result = tmp_path / "result.lrc"
        result.write_text(LRC)
        agent_service._engine_result(jobs[0], {"lrc": str(result), "source": "aligned:mms-fa", "lowLines": [1]})
        assert agent_service.get(rel).record.edited
        assert agent_service.get(rel).record.low_lines == [1]

    def test_any_later_save_drops_the_score(self, agent_service):
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.save(rel, kind=KIND_SYNCED, text=LRC, source="aligned:mms-fa", line_confidence=[0.4, 0.4], low_lines=[])
        doc = agent_service.save(rel, kind=KIND_SYNCED, text=LRC, source="manual", edited=True, force=True)
        assert doc.record.line_confidence is None and doc.record.low_lines is None

    def test_a_fresh_split_hands_the_agent_its_vocals_stem(self, agent_service, library, tmp_path):
        rel = "Multitude/Tete_brulee.mp3"
        stem = tmp_path / "vocals.ogg"
        stem.write_bytes(b"OggS")
        agent_service.vocals_lookup = lambda r: stem if r == rel else None
        agent_service.save(rel, kind=KIND_PLAIN, text=PLAIN, source="genius")
        agent_service.transcribe([(rel, None)])
        job = agent_service.agent_queue.claim({"name": "mac", "version": "0.10.0"}, max_jobs=1)["jobs"][0]
        assert job["vocalsPath"] == "/api/stems/Multitude/Tete_brulee.mp3/vocals"

    def test_the_record_round_trips_through_the_index(self, agent_service):
        rel = "Multitude/Tete_brulee.mp3"
        agent_service.save(rel, kind=KIND_SYNCED, text=LRC, source="aligned:mms-fa", line_confidence=[0.7, 0.1], low_lines=[1])
        fresh = LyricsRepository(agent_service.config, LOG)
        assert fresh.get_record(rel).low_lines == [1]


class TestSearchFailures:
    def test_manual_search_reports_catalog_failure(self, library):
        service = _service(library, ("lrclib", FakeCatalog(fail=True)))
        with pytest.raises(LyricsSearchUnavailable, match="LRCLIB:"):
            service.search("Multitude/Tete_brulee.mp3")

    def test_disabled_catalogs_are_not_an_empty_search(self, library):
        with pytest.raises(LyricsSearchUnavailable, match="No lyrics catalogs"):
            _service(library).search("Multitude/Tete_brulee.mp3")

    def test_successful_lrclib_response_is_cached(self):
        repo = TestLrclibRepository()._repo([_Response(200, [ROW])])
        query = LyricsQuery("Tête brûlée", "Stromae")
        repo.search(query)
        assert repo.search(query)[0].provider_ref == "lrclib:3396226"
        assert len(repo.session.calls) == 1

    def test_failures_are_not_cached(self):
        repo = TestLrclibRepository()._repo([_Response(503), _Response(200, [ROW])])
        query = LyricsQuery("Tête brûlée", "Stromae")
        with pytest.raises(RuntimeError):
            repo.search(query)
        assert repo.search(query)

    @pytest.mark.parametrize("exact_fails", [True, False])
    def test_one_endpoint_failure_does_not_discard_the_other_answer(self, exact_fails):
        from app.providers.adapters import LrclibLyricsProvider
        responses = [_Response(503), _Response(200, [ROW])] if exact_fails else [_Response(200, ROW), _Response(503)]
        repo = TestLrclibRepository()._repo(responses)
        result = LrclibLyricsProvider(repo).search_lyrics(LyricsQuery("Tête brûlée", "Stromae", "Multitude", 187))
        assert result[0].provider_ref == "lrclib:3396226"


def test_lrclib_repeated_throttling_starts_shared_cooldown():
    import requests
    repo = TestLrclibRepository()._repo([_Response(429), _Response(429)])
    with pytest.raises(requests.HTTPError, match="429") as error:
        repo.search(LyricsQuery("One", "Artist"))
    assert error.value.retry_after == 60
    with pytest.raises(requests.HTTPError, match="rate-limited"):
        repo.search(LyricsQuery("Two", "Artist"))
    assert len(repo.session.calls) == 2


def test_manual_source_selection_and_plain_text(library):
    lrclib = FakeCatalog({"Tête brûlée": [_candidate(plain=PLAIN)]})
    genius = FakeCatalog({"Tête brûlée": [_candidate(provider="genius", synced=None, plain=PLAIN)]})
    service = _service(library, ("lrclib", lrclib), ("genius", genius))
    _, rows = service.search("Multitude/Tete_brulee.mp3", source="lrclib", plain_only=True)
    assert rows[0].kind == KIND_PLAIN and rows[0].text == PLAIN.strip()
    assert not genius.queries
    assert lrclib.answers["Tête brûlée"][0].kind == KIND_SYNCED
    with pytest.raises(ValueError, match="Unknown lyrics source"):
        service.search("Multitude/Tete_brulee.mp3", source="arbitrary-host")


def test_lyricsovh_plain_fetch_and_cache():
    from app.domains.lyrics.plain_provider import LyricsOvhProvider
    session = _Session([_Response(200, {"lyrics": PLAIN})])
    provider = LyricsOvhProvider(session)
    query = LyricsQuery("A / title", "An artist")
    assert provider.search_lyrics(query)[0].kind == KIND_PLAIN
    assert provider.search_lyrics(query)[0].text == PLAIN.strip()
    assert len(session.calls) == 1
    assert session.calls[0][0].endswith("/An%20artist/A%20%2F%20title")


class TestSelectedAlignment:
    rel = "Multitude/Tete_brulee.mp3"

    def _service(self, library, monkeypatch, mode="agent"):
        library.config.lyrics_engine_mode = mode
        service = _service(library)
        monkeypatch.setattr(service, "engine_status", lambda: {"ready": True})
        return service

    def test_stages_selection_until_helper_saves_then_preserves_origin(self, library, monkeypatch):
        service = self._service(library, monkeypatch)
        old = service.save(self.rel, kind=KIND_SYNCED, text=LRC, source="lrclib", edited=True)
        with pytest.raises(LyricsLockedError):
            service.align(self.rel, text=PLAIN, source="genius")
        progress_id, total = service.align(self.rel, text=PLAIN, source="genius", provider_ref="g:1", force=True)
        assert total == 1 and service.get(self.rel).record == old.record
        # Persisted selection survives a repository/queue restart.
        service = self._service(library, monkeypatch)
        helper = {"name": "Studio PC", "version": "0.12.0", "jobs": ["align"]}
        claimed = service.agent_queue.claim(helper)
        job = claimed["jobs"][0]
        assert job["text"] == PLAIN
        assert "selection" not in job  # save authority stays server-side
        service.agent_queue.result(claimed["lease"], job["id"], ok=True, lrc=LRC, source="aligned:mms-fa",
                                   extra={"lineConfidence": [0.8, 0.7], "lowLines": []})
        current = service.get(self.rel)
        assert current.record.source == "genius" and current.record.provider_ref == "g:1"
        assert current.record.kind == KIND_SYNCED and not current.record.edited
        assert current.record.result["timingSource"] == "aligned:mms-fa"
        assert current.record.result["helperName"] == "Studio PC"
        assert service.progress_tracker.get_progress(progress_id).succeeded == 1

    def test_local_alignment_and_changed_revision(self, library, monkeypatch, tmp_path):
        from unittest.mock import Mock
        service = self._service(library, monkeypatch, mode="local")
        old = service.save(self.rel, kind=KIND_PLAIN, text="Old words", source="file")
        monkeypatch.setattr(service.engine, "run", Mock(return_value="local-align"))
        service.align(self.rel, text=PLAIN, source="manual", edited=True)
        job = service.engine.run.call_args.args[0][0]
        assert service.get(self.rel).record == old.record
        result = tmp_path / "result.lrc"
        result.write_text(LRC)
        service._engine_result(job, {"lrc": str(result), "source": "aligned:mms-fa"})
        assert service.get(self.rel).record.edited
        assert service.get(self.rel).record.source == "manual"
        with pytest.raises(LyricsLockedError):
            service._engine_result(job, {"lrc": str(result), "source": "aligned:mms-fa"})

    def test_failure_keeps_current(self, library, monkeypatch):
        service = self._service(library, monkeypatch)
        service.save(self.rel, kind=KIND_PLAIN, text="Older", source="file")
        old = service.save(self.rel, kind=KIND_SYNCED, text=LRC, source="lrclib")
        progress_id, _ = service.align(self.rel, text=PLAIN, source="genius")
        claimed = service.agent_queue.claim({"name": "Studio PC", "version": "0.10.0"})
        service.agent_queue.result(claimed["lease"], claimed["jobs"][0]["id"], ok=False, error="CTC failed")
        assert service.progress_tracker.get_progress(progress_id).failures[0]["reason"] == "CTC failed"
        assert service.get(self.rel).record == old.record

    def test_a_different_save_while_aligning_wins_even_after_force(self, library, monkeypatch):
        service = self._service(library, monkeypatch)
        service.save(self.rel, kind=KIND_PLAIN, text="Hand edit", source="manual", edited=True)
        service.align(self.rel, text=PLAIN, source="genius", force=True)
        service.save(self.rel, kind=KIND_PLAIN, text="New hand edit", source="manual", edited=True, force=True)
        claimed = service.agent_queue.claim({"name": "Studio PC", "version": "0.10.0"})
        service.agent_queue.result(claimed["lease"], claimed["jobs"][0]["id"], ok=True, lrc=LRC, source="aligned:mms-fa")
        assert service.get(self.rel).text == "New hand edit\n"


def test_legacy_archive_is_ignored_and_left_untouched(library):
    import json

    service = _service(library)
    rel = "Multitude/Tete_brulee.mp3"
    service.save(rel, kind=KIND_SYNCED, text=LRC, source="lrclib")
    index = library.config.lyrics_file
    data = json.loads(index.read_text())
    data["previous"] = {rel: data["entries"][rel]}
    index.write_text(json.dumps(data))
    archive = index.parent / "lyrics-previous" / "untouched.lrc"
    archive.parent.mkdir()
    archive.write_text("Archived words")
    service = _service(library)
    assert "previous" not in service.get(rel).to_dict()
    service.save(rel, kind=KIND_PLAIN, text=PLAIN, source="genius")
    service.delete(rel)
    assert archive.read_text() == "Archived words"
    assert "previous" not in json.loads(index.read_text())


def test_states_reuse_song_keys_until_the_library_area_changes(library, monkeypatch):
    import app.domains.lyrics.services as lyrics_services
    service = _service(library)
    albums = service.music_repository.scan_albums()
    service.music_repository.scan_albums = lambda: albums
    calls = []
    real = lyrics_services.rel_path_for
    monkeypatch.setattr(lyrics_services, 'rel_path_for', lambda *a: calls.append(a) or real(*a))
    first, _ = service.states(lambda rel: True)
    service.states(lambda rel: True)
    assert len(calls) == 1 and first['states'] == {'Multitude/Tete_brulee.mp3': 'none'}
    scoped, _ = service.states(lambda rel: False)
    assert scoped['states'] == {}  # The scope still filters every call.
    service.changes.bump('library')
    fresh = list(albums)
    service.music_repository.scan_albums = lambda: fresh
    service.states(lambda rel: True)
    assert len(calls) == 2
