"""Owner ghost projections reuse unchanged inputs and isolate restricted scopes."""
import logging
from contextlib import contextmanager
from dataclasses import replace
from types import SimpleNamespace

import pytest

from app.domains.music.ghosts import owner_ghosts
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_schema import ANALYSIS
from app.domains.music.repositories import MusicRepository
from app.domains.user_library.scope import LibraryScope
from app.infra.migrations import open_store


@pytest.fixture
def ghosts(tmp_path, monkeypatch):
    root = tmp_path / 'Music'
    root.mkdir()
    config = SimpleNamespace(base_music_dir=root, analysis_db=tmp_path / 'analysis.sqlite')
    repo = MusicRepository(config, logging.getLogger('test.ghosts'))
    with repo.analysis.connection() as db:
        db.execute("INSERT INTO track_analysis (rel_path, missing_since) VALUES ('Album/song.mp3', 'earlier')")
    reads = []
    connection = repo.analysis.connection

    @contextmanager
    def traced_connection():
        with connection() as db:
            db.set_trace_callback(lambda sql: reads.append(sql) if sql == 'SELECT * FROM track_analysis' else None)
            yield db

    monkeypatch.setattr(repo.analysis, 'connection', traced_connection)
    return repo, [], reads


def test_unchanged_ghosts_read_analysis_once(ghosts):
    repo, albums, reads = ghosts
    first = owner_ghosts(repo, albums, LibraryScope())
    assert first[0].tracks[0].missing_since == 'earlier'
    assert owner_ghosts(repo, albums, LibraryScope()) is first
    assert owner_ghosts(repo, list(albums), LibraryScope()) is first
    assert len(reads) == 1
    assert albums == []


@pytest.mark.parametrize('change', ['analysis', 'tags', 'removed', 'restored', 'missing_since', 'root', 'albums'])
def test_ghost_inputs_invalidate_the_memo(ghosts, tmp_path, change):
    repo, albums, reads = ghosts
    if change == 'restored':
        with repo.analysis.connection() as db:
            db.execute("INSERT INTO meta VALUES ('missing_removed:Album/song.mp3', 'edit')")
    first = owner_ghosts(repo, albums, LibraryScope())
    if change == 'analysis':
        assert repo.analysis.fix('Album/song.mp3', 0, {'bpm': 123}, 'owner')
    elif change == 'tags':
        path = repo.config.base_music_dir / 'Album/song.mp3'
        repo._tag_cache[str(path)] = ((0, 0), {'title': 'Remembered title'})
        repo._tag_revision += 1
    elif change == 'removed':
        with repo.analysis.connection() as db:
            db.execute("INSERT INTO meta VALUES ('missing_removed:Album/song.mp3', 'edit')")
    elif change == 'restored':
        repo.analysis.clear_removed_present(['Album/song.mp3'])
    elif change == 'missing_since':
        with repo.analysis.connection() as db:
            db.execute("UPDATE track_analysis SET missing_since='later'")
    elif change == 'root':
        repo.config.base_music_dir = tmp_path / 'Other'
        repo.config.base_music_dir.mkdir()
    elif change == 'albums':
        repo.scans.generation += 1
        albums = list(albums)
    if change in ('tags', 'albums'):
        # Complete the simulated publication: the library area is now a counter.
        repo.changes.bump('library')
    second = owner_ghosts(repo, albums, LibraryScope())
    assert second is not first
    assert owner_ghosts(repo, albums, LibraryScope()) is second
    assert len(reads) == 2
    if change == 'analysis':
        assert second[0].tracks[0].bpm == 123
    elif change == 'tags':
        assert second[0].tracks[0].title == 'Remembered title'
    elif change == 'removed':
        assert second == []
    elif change == 'restored':
        assert second[0].tracks[0].missing
    elif change == 'missing_since':
        assert second[0].tracks[0].missing_since == 'later'
    elif change == 'root':
        assert second[0].tracks[0].path.is_relative_to(repo.config.base_music_dir)


def test_restricted_scope_cannot_read_owner_memo(ghosts):
    repo, albums, reads = ghosts
    owner_ghosts(repo, albums, LibraryScope())
    assert owner_ghosts(repo, albums, LibraryScope(frozenset())) is albums
    assert len(reads) == 1


def test_missing_revision_changes_only_when_values_change(ghosts):
    repo, _, _ = ghosts
    revision = repo.analysis.revision
    with repo.analysis.connection() as db:
        db.execute("UPDATE track_analysis SET missing_since='earlier'")
    assert repo.analysis.revision == revision
    with repo.analysis.connection() as db:
        db.execute("UPDATE track_analysis SET missing_since=NULL")
    assert repo.analysis.revision > revision
    with repo.analysis.connection() as db:
        db.execute("INSERT INTO meta VALUES ('missing_removed:Album/song.mp3', 'edit')")
    revision = repo.analysis.revision
    with repo.analysis.connection() as db:
        db.execute("UPDATE meta SET value='edit' WHERE key='missing_removed:Album/song.mp3'")
    assert repo.analysis.revision == revision
    with repo.analysis.connection() as db:
        db.execute("UPDATE meta SET value='other-edit' WHERE key='missing_removed:Album/song.mp3'")
    assert repo.analysis.revision > revision


def test_existing_store_upgrades_missing_revision_triggers(tmp_path):
    path = tmp_path / 'analysis.sqlite'
    db = open_store(path, replace(ANALYSIS, steps=ANALYSIS.steps[:9]))
    with db:
        db.execute("INSERT INTO track_analysis (rel_path, fixed_bpm) VALUES ('Album/song.mp3', 123)")
    db.close()
    repo = AnalysisRepository(path)
    revision = repo.revision
    with repo.connection() as db:
        db.execute("UPDATE track_analysis SET missing_since='earlier'")
        assert db.execute('PRAGMA user_version').fetchone()[0] == ANALYSIS.head
    assert repo.revision > revision
    revision = repo.revision
    with repo.connection() as db:
        db.execute("INSERT INTO meta VALUES ('missing_removed:Album/song.mp3', 'edit')")
    assert repo.revision > revision
    assert AnalysisRepository(path).get('Album/song.mp3')['fixed_bpm'] == 123
