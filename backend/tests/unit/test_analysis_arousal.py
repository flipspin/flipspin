"""Library-relative intensity, durable upgrades and population refreshes."""
import json
import random
import sqlite3
from collections import Counter

import pytest

from app.domains.music.analysis_arousal import AROUSAL_RULE_VERSION, library_arousals
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_schema import ANALYSIS
from app.infra.migrations import SQLiteStore, open_store


def cue(rel, energy=.3, pulse=.8, bpm=120, **extra):
    return dict(rel_path=rel, energy=energy, pulse=pulse, bpm=bpm, missing_since=None, **extra)


def insert(repo, rows):
    with repo.connection() as db:
        db.executemany('''INSERT INTO track_analysis (rel_path, energy, pulse, bpm, missing_since)
            VALUES (:rel_path,:energy,:pulse,:bpm,:missing_since)''', rows)


def stored(repo):
    with repo.connection() as db:
        return {r['rel_path']: dict(r) for r in db.execute('SELECT * FROM track_analysis')}


def test_formula_weights_and_final_percentile_have_known_answers():
    # Feature orders differ: E=(0,1/3,2/3,1), P=(1,2/3,1/3,0), T=(1,0,1/3,2/3).
    # Weighted scores: (.5, 11/30, .5, 19/30); equal scores keep a midrank.
    rows = [cue('a', 0, 3, 150), cue('b', 1, 2, 60), cue('c', 2, 1, 90), cue('d', 3, 0, 120)]
    assert library_arousals(rows) == {'a': .5, 'b': 0, 'c': .5, 'd': 1}
    assert library_arousals(list(reversed(rows))) == library_arousals(rows)


def test_empty_single_and_tied_population():
    assert library_arousals([]) == {}
    assert library_arousals([cue('one')]) == {'one': .5}
    assert library_arousals([cue('a'), cue('b')]) == {'a': .5, 'b': .5}
    assert library_arousals([cue('a', 0, 0, 60), cue('b'), cue('c'), cue('d', 1, 2, 180)]) == {
        'a': 0, 'b': .5, 'c': .5, 'd': 1}


@pytest.mark.parametrize('field', ['energy', 'pulse', 'bpm'])
@pytest.mark.parametrize('invalid', [None, -1, float('nan'), float('inf'), float('-inf')])
def test_invalid_cues_are_null_and_do_not_change_valid_ranks(field, invalid):
    rows = [cue('low', 0, 0, 60), cue('high', 1, 2, 180), {**cue('invalid'), field: invalid}]
    assert library_arousals(rows) == {'low': 0, 'high': 1, 'invalid': None}


def test_ghosts_and_unknown_tempo_are_null_but_zero_energy_and_pulse_are_valid():
    assert library_arousals([cue('silent', 0, 0, 60), {**cue('ghost'), 'missing_since': 'earlier'},
                             cue('unknown', bpm=0)]) == {'silent': .5, 'ghost': None, 'unknown': None}


@pytest.mark.parametrize('population', ['independent', 'correlated', 'skewed', 'rounded'])
def test_no_decile_exceeds_thirty_percent_of_a_varied_library(population):
    rng = random.Random(229)
    rows = []
    for i in range(793):
        x, y, z = (rng.random() for _ in range(3))
        if population == 'correlated':
            x = y = z = i / 793
        elif population == 'skewed':
            x, y, z = x ** 8, y ** 4, z ** 2
        elif population == 'rounded':
            x, y, z = round(x, 1), round(y, 1), round(z, 1)
        rows.append(cue(str(i), x * .6, y * 2, 60 + z * 160))
    values = list(library_arousals(rows).values())
    deciles = Counter(min(int(value * 10), 9) for value in values)
    assert len(deciles) == 10
    assert max(deciles.values()) / len(rows) <= .30
    assert min(values) >= 0 and max(values) <= 1


@pytest.mark.parametrize('version', [None, '0'])
def test_startup_upgrade_preserves_every_other_field_and_is_idempotent(tmp_path, version):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    insert(repo, [cue('low', 0, 0, 60), cue('high', 1, 2, 180)])
    with repo.connection() as db:
        db.execute('''UPDATE track_analysis SET fixed_key='2A', fixed_bpm=90, rev=7,
            fixed_by='owner', fixed_at='earlier', mood='upbeat', analyzed_at='earlier',
            error='previous', engine_version=1, checked_at='earlier', tag_owner='krobi' ''')
        db.execute("INSERT INTO meta VALUES ('tag_values:low', ?)", (json.dumps({'bpm': 80}),))
        if version is not None:
            db.execute("INSERT INTO meta VALUES ('arousal_rule_version', ?)", (version,))
    before = stored(repo)
    revision = repo.revision
    repo.recompute_arousals()
    expected = {key: {**row, 'arousal': float(key == 'high')} for key, row in before.items()}
    assert stored(repo) == expected
    assert repo.revision > revision
    assert repo.meta('arousal_rule_version') == str(AROUSAL_RULE_VERSION)
    assert repo.meta('arousal_dirty') is None
    assert repo.tag_record('low', 'tag_values') == {'bpm': 80}
    revision = repo.revision
    with repo.connection() as db:
        db.execute('''CREATE TRIGGER forbid_rerank BEFORE UPDATE OF arousal ON track_analysis
            BEGIN SELECT RAISE(ABORT, 'already ranked'); END''')
    AnalysisRepository(repo.path).recompute_arousals()
    assert stored(repo) == expected
    assert repo.revision == revision


def test_empty_upgrade_and_newer_rules_are_safe(tmp_path):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    repo.recompute_arousals()
    assert repo.meta('arousal_rule_version') == str(AROUSAL_RULE_VERSION)
    insert(repo, [cue('new')])
    with repo.connection() as db:
        db.execute("UPDATE meta SET value='999' WHERE key='arousal_rule_version'")
    repo.recompute_arousals()
    assert repo.get('new')['arousal'] is None
    assert repo.meta('arousal_rule_version') == '999'


def test_upgrade_failure_rolls_back_values_version_and_listing_revision(tmp_path):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    insert(repo, [cue('song')])
    with repo.connection() as db:
        db.execute('''CREATE TRIGGER fail_version BEFORE INSERT ON meta
            WHEN NEW.key='arousal_rule_version' BEGIN SELECT RAISE(ABORT, 'interrupted'); END''')
    before, revision = stored(repo), repo.revision
    with pytest.raises(sqlite3.IntegrityError, match='interrupted'):
        repo.recompute_arousals()
    assert stored(repo) == before
    assert repo.revision == revision
    assert repo.meta('arousal_rule_version') is None
    assert repo.meta('arousal_dirty') == '1'
    with repo.connection() as db:
        db.execute('DROP TRIGGER fail_version')
    repo.recompute_arousals()
    assert repo.get('song')['arousal'] == .5


def test_population_and_measurement_changes_refresh_after_restart(tmp_path):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    insert(repo, [cue('low', 0, 0, 60), cue('mid', .3, .8, 120)])
    repo.recompute_arousals()
    assert repo.get('mid')['arousal'] == 1
    insert(repo, [cue('high', 1, 2, 180)])
    repo = AnalysisRepository(repo.path)
    repo.recompute_arousals()
    assert repo.get('mid')['arousal'] == .5
    with repo.connection() as db:
        db.execute("UPDATE track_analysis SET missing_since='earlier' WHERE rel_path='high'")
    repo.recompute_arousals()
    assert repo.get('high')['arousal'] is None
    assert repo.get('mid')['arousal'] == 1
    with repo.connection() as db:
        db.execute("UPDATE track_analysis SET missing_since=NULL WHERE rel_path='high'")
        db.execute("UPDATE track_analysis SET energy=2,pulse=3,bpm=200 WHERE rel_path='low'")
    repo.recompute_arousals()
    assert repo.get('low')['arousal'] == 1
    assert repo.get('mid')['arousal'] == 0
    repo.forget('low')
    repo.recompute_arousals()
    assert repo.get('high')['arousal'] == 1
    assert repo.meta('arousal_dirty') is None


def test_corrections_and_bookkeeping_do_not_rerank(tmp_path):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    insert(repo, [cue('song')])
    repo.recompute_arousals()
    assert repo.fix('song', 0, {'bpm': 80}, 'owner')
    with repo.connection() as db:
        db.execute("UPDATE track_analysis SET checked_at='now',size=123,mtime_ns=456")
    assert repo.meta('arousal_dirty') is None
    repo.recompute_arousals()
    assert repo.get('song')['arousal'] == .5


def test_numbered_schema_upgrade_keeps_old_analysis_rows(tmp_path):
    path = tmp_path / 'analysis.sqlite'
    old_store = SQLiteStore('analysis', ANALYSIS.steps[:7], ANALYSIS.baseline)
    db = open_store(path, old_store)
    db.execute("INSERT INTO track_analysis (rel_path,energy,pulse,bpm,fixed_bpm,rev) VALUES ('song',.3,.8,120,80,4)")
    db.commit()
    db.close()
    repo = AnalysisRepository(path)
    repo.recompute_arousals()
    assert repo.get('song')['arousal'] == .5
    assert repo.get('song')['fixed_bpm'] == 80
    assert repo.get('song')['rev'] == 4
    with repo.connection() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == len(ANALYSIS.steps)
        assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
