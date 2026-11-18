"""Stored mood upgrades reuse measurements and preserve every other column."""
import sqlite3

import pytest

from app.domains.music.analysis_mood import MOOD_RULE_VERSION, _classify_mood
from app.domains.music.analysis_repository import AnalysisRepository


@pytest.mark.parametrize('bpm,energy,brightness,pulse,expected', [
    (130, .092, .131, 0, 'ambient'),
    (130, .093, .131, 0, 'upbeat'),
    (130, .092, .132, 0, 'upbeat'),
    (138, .149, .118, 0, 'upbeat'),
    (138, .150, .118, 0, 'aggressive'),
    (118, .122, .119, 0, 'romantic'),
    (118, .123, .119, 0, 'upbeat'),
    (118, .123, .118, 0, 'romantic'),
    (95, .093, .144, .876, 'upbeat'),
    (95, .093, .144, .877, 'groovy'),
    (95, .092, .144, .877, 'upbeat'),
    (92, .122, .144, 0, 'calm'),
    (92, .123, .144, 0, 'upbeat'),
    (110, .093, .107, 0, 'melancholic'),
    (110, .093, .108, 0, 'romantic'),
    (125, .093, .143, 0, 'romantic'),
    (125, .093, .144, 0, 'upbeat'),
    (130, .093, .093, 0, 'dark'),
    (130, .093, .094, 0, 'upbeat'),
])
def test_retuned_threshold_boundaries(bpm, energy, brightness, pulse, expected):
    assert _classify_mood(bpm, energy, brightness, pulse) == expected


def stored_rows(repo):
    with repo.connection() as db:
        return {row['rel_path']: dict(row) for row in db.execute('SELECT * FROM track_analysis')}


@pytest.mark.parametrize('version', [None, '0', '1'])
def test_recompute_only_moods_once_from_computed_measurements(tmp_path, version):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    measurements = [
        ('fast.mp3', 138.1, .15, .10, 0, 'aggressive'),
        ('bright.mp3', 118.1, .123, .119, 0, 'upbeat'),
        ('no-bpm.mp3', None, .12, .14, 0, 'calm'),
        ('zeros.mp3', 80, 0, 0, 0, 'ambient'),
    ]
    with repo.connection() as db:
        if version is not None:
            db.execute("INSERT INTO meta VALUES ('mood_rule_version', ?)", (version,))
        db.execute("INSERT INTO meta VALUES ('legacy_tags_checked', 'checked')")
        db.execute("INSERT INTO meta VALUES ('tag_fields:fast.mp3', '[\"key\"]')")
        for rel, bpm, energy, brightness, pulse, _ in measurements:
            db.execute('''INSERT INTO track_analysis
                (rel_path,size,mtime_ns,engine,engine_version,key,key_conf,bpm,bpm_conf,energy,brightness,pulse,
                 mood,analyzed_at,fixed_key,fixed_bpm,fixed_by,fixed_at,rev,error,tag_owner,missing_since) VALUES (
                ?, 123, 456, 'keyfinder+tempocnn', 1, '5A', .95, ?, .87,
                ?, ?, ?, 'melancholic', 'earlier', '2A', 80, 'owner', 'corrected', 3, 'old-error', 'krobi', NULL)''',
                       (rel, bpm, energy, brightness, pulse))
        for field in ('energy', 'brightness', 'pulse'):
            db.execute('''INSERT INTO track_analysis (rel_path, bpm, energy, brightness, pulse, mood)
                VALUES (?, 140, .15, .13, 1, 'romantic')''', (field + '.mp3',))
            db.execute(f'UPDATE track_analysis SET {field} = NULL WHERE rel_path = ?', (field + '.mp3',))
        db.execute("INSERT INTO track_analysis (rel_path, error) VALUES ('failed.mp3', 'unavailable')")
    before = stored_rows(repo)

    repo.recompute_moods()

    expected = {rel: {**row} for rel, row in before.items()}
    for rel, _, _, _, _, mood in measurements:
        expected[rel]['mood'] = mood
    assert stored_rows(repo) == expected
    assert repo.meta('mood_rule_version') == str(MOOD_RULE_VERSION) == '2'
    assert repo.meta('legacy_tags_checked') == 'checked'
    assert repo.tag_fields('fast.mp3') == ['key']

    # A second boot must not issue any mood updates, even to the same value.
    with repo.connection() as db:
        db.execute('''CREATE TRIGGER forbid_recompute BEFORE UPDATE OF mood ON track_analysis
            BEGIN SELECT RAISE(ABORT, 'moods already recomputed'); END''')
    AnalysisRepository(repo.path).recompute_moods()
    assert stored_rows(repo) == expected


@pytest.mark.parametrize('version', ['2', '3'])
def test_current_or_newer_mood_version_is_untouched(tmp_path, version):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    with repo.connection() as db:
        db.execute("INSERT INTO meta VALUES ('mood_rule_version', ?)", (version,))
        db.execute('''INSERT INTO track_analysis (rel_path, bpm, energy, brightness, pulse, mood)
            VALUES ('song.mp3', 140, .15, .13, 1, 'romantic')''')
    before = stored_rows(repo)
    repo.recompute_moods()
    assert stored_rows(repo) == before
    assert repo.meta('mood_rule_version') == version


def test_mood_upgrade_rolls_back_rows_and_version_on_failure(tmp_path):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    with repo.connection() as db:
        db.execute("INSERT INTO meta VALUES ('mood_rule_version', '1')")
        db.execute('''INSERT INTO track_analysis (rel_path, bpm, energy, brightness, pulse, mood)
            VALUES ('song.mp3', 140, .15, .13, 1, 'romantic')''')
        db.execute('''CREATE TRIGGER fail_version BEFORE INSERT ON meta
            WHEN NEW.key = 'mood_rule_version'
            BEGIN SELECT RAISE(ABORT, 'interrupted'); END''')
    before = stored_rows(repo)
    with pytest.raises(sqlite3.IntegrityError, match='interrupted'):
        repo.recompute_moods()
    assert stored_rows(repo) == before
    assert repo.meta('mood_rule_version') == '1'

    with repo.connection() as db:
        db.execute('DROP TRIGGER fail_version')
    repo.recompute_moods()
    assert repo.get('song.mp3') == {**before['song.mp3'], 'mood': 'aggressive'}
    assert repo.meta('mood_rule_version') == '2'


def test_empty_library_records_mood_version(tmp_path):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    repo.recompute_moods()
    assert stored_rows(repo) == {}
    assert repo.meta('mood_rule_version') == '2'
