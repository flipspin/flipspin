"""Durable migration, receipt priority, immutable dates and content aliases."""
import hashlib
import logging
import os
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_schema import ANALYSIS
from app.domains.music.first_seen import FirstSeen
from app.infra.jobs import Jobs
from app.infra.jobs.receipts import library_receipts
from app.infra.migrations import open_store
from tests.unit.test_acquisition import pipeline as pipeline, submit


@pytest.fixture
def catalog(tmp_path):
    root = tmp_path / 'Music'
    root.mkdir()
    config = SimpleNamespace(base_music_dir=root, jobs_file=tmp_path / 'jobs.sqlite', analysis_db=tmp_path / 'analysis.sqlite')
    repo = AnalysisRepository(config.analysis_db)
    return config, repo, FirstSeen(repo, config)


def song(config, name='Album/song.mp3'):
    path = config.base_music_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'audio')
    os.utime(path, (1900000000, 1900000000))
    return path


def receipt(ledger, path, stamp=1234567890.5, kind='acquisition-import'):
    ledger.now = lambda: stamp
    job = ledger.start(kind, 'Import', [{'item': path.name, 'detail': {'_path': str(path)}}], 'system')
    ledger.item_transition(job, 0, 1, 'running')
    ledger.item_transition(job, 0, 1, 'done')
    ledger.finish(job, 1)
    return job


def test_backfill_prefers_receipt_over_rewritten_mtime_and_birthtime(catalog, caplog):
    config, repo, dates = catalog
    path = song(config)
    with closing(Jobs(config.jobs_file)) as ledger:
        receipt(ledger, path)
    with caplog.at_level(logging.INFO):
        assert dates.backfill()
        assert not FirstSeen(repo, config).backfill()
    assert caplog.text.count('Library first-seen backfill') == 1
    assert 'receipt=1 birthtime=0 mtime=0' in caplog.text
    assert dates.get(path) == 1234567890.5
    os.utime(path, (2000000000, 2000000000))
    assert FirstSeen(repo, config).get(path, receipt=42) == 1234567890.5


def test_new_file_uses_birthtime_else_mtime_and_is_durable(catalog):
    config, repo, dates = catalog
    path = song(config)
    stat = path.stat()
    expected = getattr(stat, 'st_birthtime', None) or stat.st_mtime
    assert dates.get(path) == expected
    assert FirstSeen(repo, config).get(path) == expected


def test_upload_receipt_and_sha_follow_refiling(catalog):
    config, repo, dates = catalog
    path = song(config)
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    with closing(Jobs(config.jobs_file)) as ledger:
        job = receipt(ledger, path, kind='import')
        with ledger.lock, ledger.db:
            ledger.db.execute('''INSERT INTO upload_items
                (account,sha256,batch,body,state,hit,updated,received_at) VALUES ('owner',?,?,?,'agregada',?,?,?)''',
                (sha, job, '{}', str(path), 1999999999, 1234567990.5))
    assert library_receipts(config.jobs_file, config.base_music_dir)['Album/song.mp3'] == (1234567890.5, sha)
    historical = song(config, 'Historical/renamed.mp3')
    assert dates.get(historical) == 1234567890.5
    assert dates.get(path) == 1234567890.5
    filed = song(config, 'Artist/Album/renamed.mp3')
    assert dates.published(filed, receipt=1999999999, sha=sha) == 1234567890.5
    # The content alias survives opening the database in a fresh process.
    again = song(config, 'Other/copy.mp3')
    assert FirstSeen(repo, config).get(again, receipt=2000000000, sha=sha) == 1234567890.5


def test_unavailable_root_does_not_complete_backfill(catalog):
    config, repo, dates = catalog
    config.base_music_dir.rmdir()
    assert not dates.backfill()
    path = song(config)
    assert dates.backfill()
    assert dates.get(path) is not None


def test_additive_upgrade_keeps_existing_analysis(tmp_path):
    path = tmp_path / 'analysis.sqlite'
    old = replace(ANALYSIS, steps=ANALYSIS.steps[:-1])
    db = open_store(path, old)
    db.execute("INSERT INTO track_analysis(rel_path,fixed_bpm,rev) VALUES ('Album/song.mp3',100,3)")
    db.commit(); db.close()
    repo = AnalysisRepository(path)
    assert repo.get('Album/song.mp3')['fixed_bpm'] == 100
    assert repo.get('Album/song.mp3')['rev'] == 3
    with repo.connection() as db:
        assert db.execute('SELECT count(*) FROM library_first_seen').fetchone()[0] == 0


def test_direct_repository_move_preserves_date(catalog):
    from app.domains.music.repositories import MusicRepository
    config, _, _ = catalog
    path = song(config)
    music = MusicRepository(config, logging.getLogger('test'))
    music.first_seen.get(path, receipt=1234567890.5)
    destination = config.base_music_dir / 'Moved/renamed.mp3'
    music.move_file(path, destination)
    assert music.first_seen.get(destination) == 1234567890.5


def test_upload_receipt_upgrade_and_mutable_update_do_not_change_time(tmp_path):
    from app.infra.jobs.schema import JOBS, upload_receipt_time
    path = tmp_path / 'jobs.sqlite'
    db = open_store(path, replace(JOBS, steps=JOBS.steps[:JOBS.steps.index(upload_receipt_time)]))
    db.execute("INSERT INTO upload_items(account,sha256,batch,body,state,updated) VALUES ('owner','sha','batch','{}','agregada',123)")
    db.commit(); db.close()
    with closing(Jobs(path)) as ledger:
        assert ledger.db.execute('SELECT received_at FROM upload_items').fetchone()[0] == 123
        with ledger.db:
            ledger.db.execute('UPDATE upload_items SET updated=999')
        assert ledger.db.execute('SELECT received_at FROM upload_items').fetchone()[0] == 123


def test_filesystem_without_birthtime_seeds_from_mtime(catalog, monkeypatch):
    config, _, dates = catalog
    path = song(config)
    native_stat = Path.stat
    class WithoutBirthtime:
        def __init__(self, stat):
            self.stat = stat
        def __getattr__(self, name):
            if name == 'st_birthtime':
                raise AttributeError(name)
            return getattr(self.stat, name)
    def stat(candidate, *args, **kwargs):
        result = native_stat(candidate, *args, **kwargs)
        return WithoutBirthtime(result) if candidate == path else result
    monkeypatch.setattr(Path, 'stat', stat)
    assert dates.get(path) == 1900000000.0


@pytest.mark.asyncio
async def test_acquisition_publication_records_the_request_receipt(pipeline, monkeypatch):
    from app.domains.music.repositories import MusicRepository
    config = SimpleNamespace(base_music_dir=pipeline.root, jobs_file=pipeline.ledger.path,
                             analysis_db=pipeline.data / 'analysis.sqlite')
    music = MusicRepository(config, logging.getLogger('test'))
    pipeline.music = music
    clock = [1234567890.5]
    pipeline.ledger.now = lambda: clock[0]
    request = submit(pipeline)
    observed = []
    replace_file = os.replace
    def scan_at_publication(source, destination):
        replace_file(source, destination)
        if Path(destination).suffix == '.mp3' and Path(destination).is_relative_to(pipeline.root):
            observed.append(music.first_seen.get(Path(destination)))
    monkeypatch.setattr('app.domains.music.writer.os.replace', scan_at_publication)
    clock[0] += 100
    results = await pipeline.run(request['id'])
    assert observed == [1234567890.5]
    assert results[0].success
    path = results[0].file_path
    assert music.first_seen.get(path) == 1234567890.5
    os.utime(path, (2000000000, 2000000000))
    assert FirstSeen(music.analysis, config).get(path) == 1234567890.5


def test_receipt_hash_lookup_never_opens_an_escaping_symlink(catalog, tmp_path, monkeypatch):
    from app.infra.jobs.receipts import LibraryReceipts
    config, _, _ = catalog
    outside = tmp_path / 'outside.mp3'
    outside.write_bytes(b'audio')
    linked = config.base_music_dir / 'escape.mp3'
    linked.symlink_to(outside)
    receipts = LibraryReceipts()
    receipts.by_sha[hashlib.sha256(b'audio').hexdigest()] = 123
    def forbidden(*args, **kwargs):
        raise AssertionError('outside audio was opened')
    monkeypatch.setattr(Path, 'open', forbidden)
    assert receipts.for_path(config.base_music_dir, linked) == (None, None)


def test_missing_remembered_track_still_uses_its_ledger_receipt(catalog):
    config, _, dates = catalog
    path = song(config)
    with closing(Jobs(config.jobs_file)) as ledger:
        receipt(ledger, path)
    path.unlink()
    assert dates.get(path, fallback=1900000000.0) == 1234567890.5
