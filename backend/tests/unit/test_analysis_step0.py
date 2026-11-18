"""Contract checks 7, 8 and 14, plus the durable record and tag readers."""
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import Mock

import pytest
from mutagen.id3 import ID3, TBPM, TKEY, TXXX

from app.domains.music.analysis_legacy import migrate_legacy_tags
from app.domains.music.analysis_precedence import key_info, precedence
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_tags import analysis_tags
from app.domains.music.repositories import MusicRepository
from app.utils.library_paths import rel_path_for

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / 'contracts/analysis.json').read_text())
FRAME = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 40


@pytest.mark.parametrize('case', CONTRACT['cases'], ids=lambda case: case['name'])
def test_check_7_precedence_contract(case):
    assert precedence(**case['in']) == case['out']


def test_check_8_listing_never_computes(config, tmp_path):
    """A fresh interpreter makes the no-librosa assertion independent of test order."""
    script = '''
import asyncio
import json
import logging
import sys
import threading
from unittest.mock import Mock, patch
import httpx
from fastapi import FastAPI
from starlette.requests import Request
from app.config import ConfigManager
from app.dependencies import DependencyContainer, get_music_service, get_library_scope
from app.domains.music.repositories import MusicRepository
from app.domains.music.services import MusicService
from app.domains.music.routes import router
from app.domains.user_library.scope import LibraryScope
from app.infra.jobs.queue import Queue
config = ConfigManager.from_env()
repo = MusicRepository(config, logging.getLogger('test'))
service = MusicService(repo, Mock(), config, logging.getLogger('test'))
app = FastAPI()
app.state.container = DependencyContainer(config)
app.state.container._repositories['music_repository'] = repo
app.state.container._services['analysis_repository'] = repo.analysis
app.include_router(router)
app.dependency_overrides[get_music_service] = lambda: service
scope = LibraryScope()
app.dependency_overrides[get_library_scope] = lambda: scope
async def run():
    # Resolve dependencies before forbidding thread creation (FastAPI runs sync
    # dependencies in its request pool). The listing itself must spawn nothing.
    from app.domains.music.routes import list_albums_with_metadata
    with patch.object(threading.Thread, 'start', side_effect=AssertionError('thread started')), \\
         patch.object(Queue, 'enqueue', side_effect=AssertionError('enqueued')):
        body = json.loads(list_albums_with_metadata.__wrapped__(request=Request({'type': 'http', 'headers': []}), music_service=service, scope=scope, covers=False).body)
        assert len(body) == 1 and len(body[0]['tracks']) == 1
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        with patch.object(Queue, 'enqueue', side_effect=AssertionError('enqueued')):
            response = await client.get('/api/listar-albums-con-metadata?covers=false')
        assert response.status_code == 200, response.text
        track = response.json()[0]['tracks'][0]
        assert (track['bpm'], track['key'], track['mood']) == (None, None, None)
    assert 'librosa' not in sys.modules
    assert 'app.domains.music.analysis' not in sys.modules
    with repo.analysis.connection() as db:
        assert db.execute('SELECT count(*) FROM track_analysis').fetchone()[0] == 0
asyncio.run(run())
print('check 8: listing enqueued nothing, started no analysis thread, imported no librosa')
'''
    album = config.base_music_dir / 'Album'
    album.mkdir()
    (album / 'track.mp3').write_bytes(FRAME)
    env = dict(os.environ)
    for name, value in {
        'KROBI_MUSIC_DIR': config.base_music_dir, 'KROBI_PLAYLIST_DIR': config.playlist_dir,
        'KROBI_TEMP_DIR': config.temp_dir, 'KROBI_ANALYSIS_DB': config.analysis_db,
        'KROBI_JOBS_FILE': config.jobs_file,
        'KROBI_LOG_DIR': config.log_dir, 'KROBI_CREDENTIALS_DIR': config.credentials_dir,
    }.items():
        env[name] = str(value)
    result = subprocess.run([sys.executable, '-c', script], env=env, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    print(result.stdout.strip())


def tagged_track(config, name='a.mp3', bpm='128', key='Am'):
    path = config.base_music_dir / 'Album' / name
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(FRAME)
    tags = ID3()
    tags.add(TBPM(encoding=3, text=[bpm]))
    tags.add(TKEY(encoding=3, text=[key]))
    tags.add(TXXX(encoding=3, desc='INITIALKEY', text=['8A']))
    tags.save(path)
    return path


def cache_for(config, paths):
    cache = {}
    for path in paths:
        stat = path.stat()
        cache[str(path)] = {'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns,
                            'bpm': 128, 'key': 'A', 'scale': 'minor', 'key_name': 'A minor', 'camelot': '8A'}
    file = config.temp_dir / 'audio_analysis_cache.json'
    file.write_text(json.dumps(cache))
    return file


def test_check_14_legacy_tags_hidden_and_foreign_tags_preserved(config):
    a = tagged_track(config)
    b = tagged_track(config, 'b.mp3', bpm='130')
    c = tagged_track(config, 'c.mp3', key='F#')
    cache = cache_for(config, [a, b, c])
    before = {p: p.read_bytes() for p in [a, b, c]}
    repo = MusicRepository(config, logging.getLogger('test'))
    assert repo.get_track_info(a).bpm == 128
    assert migrate_legacy_tags(config, repo.analysis) == {'entries': 3, 'matched': 1, 'skipped': 2}
    assert not cache.exists()
    row = repo.analysis.get('Album/a.mp3')
    assert row['tag_owner'] == 'krobi'
    assert all(row[field] is None for field in ('bpm', 'key', 'mood', 'energy', 'engine', 'analyzed_at'))
    track = repo.scan_albums()[0].tracks[0]
    assert (track.bpm, track.key, track.mood) == (None, None, None)
    assert repo.get_track_info(b).bpm == 130
    assert repo.get_track_info(c).key == 'F# major'
    summary = repo.analysis.meta('legacy_tags_checked')
    assert migrate_legacy_tags(config, repo.analysis) is None
    assert repo.analysis.get('Album/a.mp3') == row
    assert repo.analysis.meta('legacy_tags_checked') == summary
    assert {p: p.read_bytes() for p in before} == before
    print('check 14: matching old tags hidden; foreign tags visible; second pass unchanged; audio unchanged')


def test_check_14_failed_pass_keeps_cache_and_retries(config, monkeypatch):
    a = tagged_track(config)
    b = tagged_track(config, 'b.mp3')
    cache = cache_for(config, [a, b])
    repo = AnalysisRepository(config.analysis_db)
    from app.domains.music import analysis_legacy
    original = analysis_legacy._matches
    def fail(path, entry):
        if path == b:
            raise RuntimeError('interrupted')
        return original(path, entry)
    monkeypatch.setattr(analysis_legacy, '_matches', fail)
    with pytest.raises(RuntimeError, match='interrupted'):
        migrate_legacy_tags(config, repo)
    assert cache.exists()
    assert repo.meta('legacy_tags_checked') is None
    assert repo.get('Album/a.mp3') is None
    monkeypatch.setattr(analysis_legacy, '_matches', original)
    assert migrate_legacy_tags(config, repo)['matched'] == 2
    assert not cache.exists()
    print('check 14: failed pass retained cache and committed no partial rows; retry succeeded')


@pytest.mark.parametrize('tags,bpm,key', [
    ({'TBPM': TBPM(text=['123.5']), 'TKEY': TKEY(text=['Am'])}, 123.5, '8A'),
    ({'TXXX:INITIALKEY': TXXX(desc='INITIALKEY', text=['2B'])}, None, '2B'),
    ({'bpm': ['128'], 'initialkey': ['A minor']}, 128, '8A'),
    ({'key': ['Db major']}, None, '3B'),
    ({'tmpo': [130]}, 130, None),
    ({'bpm': ['nan'], 'key': ['invalid']}, None, None),
])
def test_tag_formats(tags, bpm, key):
    result = analysis_tags(tags)
    assert result['bpm'] == bpm
    assert key_info(result['key'])['camelot'] == key


@pytest.mark.parametrize('extension', ['mp3', 'flac', 'ogg', 'm4a', 'opus'])
def test_marker_tags_are_hidden(config, extension, write_audio):
    from app.domains.metadata import tagwriter

    path = config.base_music_dir / f'marked.{extension}'
    write_audio(path, [0.] * 8000, 8000)
    tagwriter.write(path, {'bpm': 128, 'key': 'Am', 'analysisMarker': 'engine@1'},
                    expected=tagwriter.identity(path))
    repo = MusicRepository(config, logging.getLogger('test'))
    track = repo.get_track_info(path)
    assert (track.bpm, track.key) == (None, None)


def test_record_schema_wal_config_and_orphan_sweep(config, monkeypatch):
    assert config.analysis_db == config.playlist_dir.parent / 'analysis.sqlite'
    monkeypatch.setenv('KROBI_ANALYSIS_DB', str(config.temp_dir / 'override.sqlite'))
    from app.config import ConfigManager
    assert ConfigManager.from_env().analysis_db == config.temp_dir / 'override.sqlite'
    repo = MusicRepository(config, logging.getLogger('test'))
    with repo.analysis.connection() as db:
        assert db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
        columns = {r['name'] for r in db.execute('PRAGMA table_info(track_analysis)')}
        assert columns == set('rel_path size mtime_ns engine engine_version key key_conf bpm bpm_conf energy brightness pulse mood analyzed_at fixed_key fixed_bpm fixed_by fixed_at rev error tag_owner missing_since checked_at analyzed_by accel arousal track_lufs true_peak lra decode_seconds loudness_blocks album_gain album_peak'.split())
    paths = [config.base_music_dir / p for p in ('Artist/Album/CD1/a.mp3', 'literal∕album/b.mp3', 'root.mp3')]
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(FRAME)
        with repo.analysis.connection() as db:
            db.execute('INSERT INTO track_analysis (rel_path, fixed_bpm) VALUES (?, 123)', (rel_path_for(config.base_music_dir, path),))
    with repo.analysis.connection() as db:
        db.execute("INSERT INTO track_analysis (rel_path) VALUES ('Missing/gone.mp3')")
    assert len(repo.scan_albums()) == 3
    assert repo.analysis.get('Missing/gone.mp3')['missing_since'] is not None
    assert all(repo.analysis.get(rel_path_for(config.base_music_dir, p))['fixed_bpm'] == 123 for p in paths)
    paths[0].unlink()
    repo.scan_albums()
    missing = repo.analysis.get(rel_path_for(config.base_music_dir, paths[0]))
    assert missing['missing_since'] is not None and missing['fixed_bpm'] == 123


def test_legacy_signature_mismatch_and_missing_files_are_skipped(config):
    a = tagged_track(config)
    b = tagged_track(config, 'b.mp3')
    cache_for(config, [a, b])
    a.write_bytes(a.read_bytes() + b'changed')
    b.unlink()
    repo = AnalysisRepository(config.analysis_db)
    assert migrate_legacy_tags(config, repo) == {'entries': 2, 'matched': 0, 'skipped': 2}
    assert repo.get('Album/a.mp3') is None


@pytest.mark.parametrize('tags,expected', [
    ({'TBPM': ['128'], 'TXXX:INITIALKEY': ['8A']}, True),
    ({'TBPM': ['128'], 'TKEY': ['Am'], 'TXXX:INITIALKEY': ['2B']}, False),
    ({'TBPM': ['128']}, False),
    ({'TKEY': ['Am']}, False),
])
def test_legacy_compares_all_present_id3_key_tags(config, monkeypatch, tags, expected):
    from app.domains.music import analysis_legacy
    path = tagged_track(config)
    cache = cache_for(config, [path])
    entry = json.loads(cache.read_text())[str(path)]
    monkeypatch.setattr(analysis_legacy, 'ID3', lambda _: tags)
    assert analysis_legacy._matches(path, entry) is expected


def test_legacy_vorbis_matches_key_name(config, write_audio):
    import numpy as np
    from mutagen.flac import FLAC
    path = config.base_music_dir / 'song.flac'
    write_audio(path, np.zeros(1000), 8000)
    audio = FLAC(path)
    audio['bpm'], audio['initialkey'], audio['camelot'] = '128', 'A minor', '8A'
    audio.save()
    cache_for(config, [path])
    before = path.read_bytes()
    repo = MusicRepository(config, logging.getLogger('test'))
    assert repo.get_track_info(path).key == 'A minor'
    assert migrate_legacy_tags(config, repo.analysis)['matched'] == 1
    assert repo.get_track_info(path).key is None
    assert path.read_bytes() == before


def test_legacy_commit_precedes_cache_unlink_and_unlink_can_retry(config, monkeypatch):
    path = tagged_track(config)
    cache = cache_for(config, [path])
    repo = AnalysisRepository(config.analysis_db)
    unlink = Path.unlink
    def fail_unlink(path, *args, **kwargs):
        if path == cache:
            assert repo.meta('legacy_tags_checked') is not None
            raise OSError('cannot unlink')
        return unlink(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', fail_unlink)
    with pytest.raises(OSError, match='cannot unlink'):
        migrate_legacy_tags(config, repo)
    assert cache.exists()
    row = repo.get('Album/a.mp3')
    monkeypatch.setattr(Path, 'unlink', unlink)
    assert migrate_legacy_tags(config, repo) is None
    assert repo.get('Album/a.mp3') == row
    assert not cache.exists()


def test_legacy_startup_never_waits_for_database_or_tags(config, monkeypatch):
    import threading
    from app.domains.music import analysis_legacy
    started, release = threading.Event(), threading.Event()
    def factory():
        started.set()
        assert release.wait(3)
        return AnalysisRepository(config.analysis_db)
    complete = Mock()
    thread = analysis_legacy.start_legacy_tag_check(config, factory, complete)
    try:
        assert started.wait(3)
        assert thread.is_alive()
        complete.assert_not_called()
    finally:
        release.set()
        thread.join(3)
    assert not thread.is_alive()
    complete.assert_called_once()


def test_analysis_row_follows_move_and_preserves_corrections(config):
    path = tagged_track(config)
    repo = AnalysisRepository(config.analysis_db)
    with repo.connection() as db:
        db.execute("INSERT INTO track_analysis (rel_path, fixed_bpm, rev, tag_owner) VALUES ('Album/a.mp3', 123, 2, 'krobi')")
    destination = path.with_name('renamed.mp3')
    path.rename(destination)
    repo.repoint(config.base_music_dir, path, destination)
    assert repo.get('Album/a.mp3') is None
    row = repo.get('Album/renamed.mp3')
    assert (row['fixed_bpm'], row['rev'], row['tag_owner']) == (123, 2, 'krobi')


@pytest.mark.parametrize('bpm,energy,brightness,pulse,expected', [
    (80, .09, .13, 0, 'ambient'), (138, .15, .13, 1, 'aggressive'),
    (118, .123, .119, 1, 'upbeat'), (110, .093, .14, .877, 'groovy'),
    (92, .12, .14, 0, 'calm'), (110, .10, .107, 0, 'melancholic'),
    (125, .10, .143, 0, 'romantic'), (130, .10, .093, 0, 'dark'),
])
def test_retuned_pure_mood_rule(bpm, energy, brightness, pulse, expected):
    from app.domains.music.analysis_mood import _classify_mood
    assert _classify_mood(bpm, energy, brightness, pulse) == expected


def test_analysis_identity_survives_library_root_move(config):
    tagged_track(config)
    repo = MusicRepository(config, logging.getLogger('test'))
    with repo.analysis.connection() as db:
        db.execute("INSERT INTO track_analysis (rel_path, fixed_key, fixed_bpm) VALUES ('Album/a.mp3', '2A', 123)")
    destination = config.base_music_dir.with_name('moved-library')
    config.base_music_dir.rename(destination)
    config.base_music_dir = destination
    track = repo.scan_albums()[0].tracks[0]
    assert (track.key, track.bpm) == ('D# minor', 123)
    assert repo.analysis.get('Album/a.mp3') is not None


def test_legacy_untagged_mp3_is_skipped_without_aborting_the_pass(config):
    path = config.base_music_dir / 'untagged.mp3'
    path.write_bytes(FRAME)
    cache = cache_for(config, [path])
    repo = AnalysisRepository(config.analysis_db)
    assert migrate_legacy_tags(config, repo) == {'entries': 1, 'matched': 0, 'skipped': 1}
    assert not cache.exists()
    assert repo.get(rel_path_for(config.base_music_dir, path)) is None
