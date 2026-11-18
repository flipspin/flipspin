"""Missing library files never erase hand values or their tag provenance."""
import os
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.domains.music.analysis_constants import MISSING_GRACE_DAYS
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_schema import ANALYSIS, base
from app.domains.user_library.scope import LibraryScope
from app.utils.library_paths import rel_path_for
from tests.unit.test_analysis_step1 import AGENT, analysis as analysis, claim, measurement, submit

META = {'tag_fields': ['key'], 'tag_values': {'key': '2A'}, 'tag_originals': {'key': '5A'}}


def remember(repo, rel, **values):
    with repo.connection() as db:
        db.execute(f"INSERT INTO track_analysis (rel_path, {', '.join(values)}) "
                   f"VALUES (?, {', '.join('?' for _ in values)})", (rel, *values.values()))
    for kind, value in META.items():
        repo.tag_record(rel, kind, value)


def provenance(repo, rel):
    return {kind: repo.meta(f'{kind}:{rel}') for kind in META}


@pytest.mark.parametrize('unavailable', ['absent', 'empty', 'non-audio', 'unreadable', 'partial-read'])
def test_unavailable_library_skips_all_changes_and_purges(analysis, monkeypatch, caplog, unavailable):
    a = analysis
    rel = 'Album/song.mp3'
    age = (datetime.now(UTC) - timedelta(days=31)).isoformat()
    remember(a.repo, rel, fixed_key='2A', fixed_bpm=123, missing_since=age)
    remember(a.repo, 'Album/uncorrected.mp3', missing_since=age)
    before = {r: (a.repo.get(r), provenance(a.repo, r)) for r in (rel, 'Album/uncorrected.mp3')}
    root = a.config.base_music_dir
    if unavailable == 'absent':
        root.rmdir()
    elif unavailable == 'non-audio':
        (root / 'readme.txt').write_text('No audio here')
    elif unavailable in ('unreadable', 'partial-read'):
        if unavailable == 'partial-read':
            a.song()
            (root / 'blocked').mkdir()
        original = os.scandir

        def denied(path):
            if not isinstance(path, int) and Path(path) == (root / 'blocked' if unavailable == 'partial-read' else root):
                raise PermissionError('synthetic unreadable directory')
            return original(path)

        monkeypatch.setattr(os, 'scandir', denied)
    assert a.repo.sweep(root) == 0
    assert a.service.scan() == 0
    a.music.scan_albums()
    assert before == {r: (a.repo.get(r), provenance(a.repo, r)) for r in before}
    assert 'Analysis sweep skipped' in caplog.text


@pytest.mark.parametrize('fixed', [{'key': '2A'}, {'bpm': 123.5}, {'key': '5A', 'bpm': 123.5}])
@pytest.mark.parametrize('location', ['Album', 'Artist/Album/CD1', 'literal∕album', ''])
def test_ghost_restores_same_path_with_corrections_and_metadata(analysis, fixed, location):
    a = analysis
    path = a.song(folder=location)
    a.song('present.mp3', 'Other')
    rel = rel_path_for(a.config.base_music_dir, path)
    a.service.scan()
    got = claim(a)
    submit(a, got, [measurement(i, keyConf=0, bpmConf=0) for i in got['job']['input']['items']])
    assert a.service.fix(rel, path, a.repo.get(rel)['rev'], fixed, 'owner')[0]
    for kind, value in META.items():
        a.repo.tag_record(rel, kind, value)
    before, meta = a.repo.get(rel), provenance(a.repo, rel)
    content, signature = path.read_bytes(), path.stat()
    # Populate the listing cache before the file disappears.
    a.service.estimates(None, 50, LibraryScope())
    path.unlink()

    assert a.service.scan() == 0
    ghost = a.repo.get(rel)
    assert ghost['missing_since'] is not None
    assert ghost['arousal'] is None
    assert {**ghost, 'missing_since': None, 'arousal': before['arousal']} == before
    assert provenance(a.repo, rel) == meta
    # A second sweep cannot restart the grace period.
    assert a.repo.sweep(a.config.base_music_dir) == 0
    assert a.repo.get(rel) == ghost
    summary = a.service.summary()
    assert (summary['total'], summary['analyzed'], summary['queued'], summary['failed']) == (1, 1, 0, 0)
    assert summary['estimated'] == {'songs': 1, 'keys': 1, 'bpms': 1}
    assert rel not in {r['relPath'] for r in a.service.estimates(None, 50, LibraryScope())['rows']}
    assert a.service.enqueue_files([path]) == 0

    path.write_bytes(content)
    os.utime(path, ns=(signature.st_atime_ns, signature.st_mtime_ns))
    assert a.service.scan() == 0
    assert a.repo.get(rel) == before
    assert provenance(a.repo, rel) == meta
    view = a.service.view(rel, path)
    for field, value in fixed.items():
        assert view[field] == {'value': value, 'source': 'fixed', 'estimated': False}
    assert a.service.summary()['total'] == 2


@pytest.mark.parametrize('fixed_key,fixed_bpm', [(None, None), ('2A', None), (None, 123), ('5A', 123.5)])
@pytest.mark.parametrize('age', [29, 31])
def test_purge_requires_grace_period_and_no_hand_value(analysis, fixed_key, fixed_bpm, age):
    a = analysis
    a.song('present.mp3')
    rel = 'Album/gone.mp3'
    since = (datetime.now(UTC) - timedelta(days=age)).isoformat()
    remember(a.repo, rel, fixed_key=fixed_key, fixed_bpm=fixed_bpm, missing_since=since,
             fixed_by='owner', fixed_at='earlier', rev=4, tag_owner='krobi')
    before, meta = a.repo.get(rel), provenance(a.repo, rel)
    purge = age > MISSING_GRACE_DAYS and fixed_key is None and fixed_bpm is None
    assert a.repo.sweep(a.config.base_music_dir) == int(purge)
    if purge:
        assert a.repo.get(rel) is None
        assert all(value is None for value in provenance(a.repo, rel).values())
    else:
        assert a.repo.get(rel) == before
        assert provenance(a.repo, rel) == meta


def test_restored_old_uncorrected_ghost_is_cleared_before_purge(analysis):
    a = analysis
    a.song()
    since = (datetime.now(UTC) - timedelta(days=31)).isoformat()
    remember(a.repo, 'Album/song.mp3', missing_since=since)
    meta = provenance(a.repo, 'Album/song.mp3')
    assert a.repo.sweep(a.config.base_music_dir) == 0
    assert a.repo.get('Album/song.mp3')['missing_since'] is None
    assert provenance(a.repo, 'Album/song.mp3') == meta


def test_ghosts_cannot_enqueue_or_claim_previously_queued_work(analysis):
    a = analysis
    path = a.song()
    a.song('present.mp3')
    assert a.service.scan() == 2
    remember(a.repo, 'Album/song.mp3', fixed_key='2A')
    content = path.read_bytes()
    path.unlink()
    a.service.scan()
    # Queued work survives and becomes eligible again on restoration.
    assert a.service.summary()['queued'] == 1
    got = claim(a)
    assert [r['relPath'] for r in got['job']['input']['items']] == ['Album/present.mp3']
    submit(a, got)
    assert a.service.claim(AGENT) is None
    path.write_bytes(content)
    # Existing on disk is insufficient while still marked missing.
    assert a.service.enqueue_files([path]) == 0
    assert a.service.summary()['total'] == 1
    a.service.scan()
    assert [r['relPath'] for r in claim(a)['job']['input']['items']] == ['Album/song.mp3']


def test_unversioned_analysis_upgrade_is_additive_and_idempotent(tmp_path):
    path = tmp_path / 'analysis.sqlite'
    with sqlite3.connect(path) as db:
        base(db)
        db.execute("INSERT INTO track_analysis (rel_path, fixed_key, fixed_bpm, rev) VALUES ('Album/a.mp3', '2A', 123, 7)")
        for kind, value in META.items():
            db.execute('INSERT INTO meta VALUES (?, ?)', (f'{kind}:Album/a.mp3', str(value)))
        old_row = db.execute('SELECT * FROM track_analysis').fetchone()
        old_meta = db.execute('SELECT * FROM meta').fetchall()
    repo = AnalysisRepository(path)
    with repo.connection() as db:
        row = tuple(db.execute('SELECT * FROM track_analysis').fetchone())
        assert row[:len(old_row)] == old_row
        assert row[len(old_row):] == (None,) * 12
        assert [tuple(r) for r in db.execute('SELECT * FROM meta')] == [*old_meta, ('arousal_dirty', '1')]
        assert db.execute('PRAGMA user_version').fetchone()[0] == len(ANALYSIS.steps)
    snapshots = list((tmp_path / 'backups').glob('analysis.*.sqlite'))
    assert len(snapshots) == 1
    with sqlite3.connect(snapshots[0]) as db:
        assert db.execute('SELECT * FROM track_analysis').fetchone() == old_row
    assert AnalysisRepository(path).get('Album/a.mp3') == repo.get('Album/a.mp3')
    assert list((tmp_path / 'backups').glob('analysis.*.sqlite')) == snapshots
