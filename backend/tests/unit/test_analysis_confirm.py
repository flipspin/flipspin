"""Confirmation/reset effects and the scoped, owner-only review queue."""
import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from mutagen.id3 import ID3

from app.dependencies import get_library_scope
from app.domains.music.analysis_tags import analysis_tags
from app.domains.user_library.scope import LibraryScope
from app.infra.identity import require_owner
from tests.unit.test_analysis_step1 import analysis as analysis, api as api, claim, measurement, put_tags, submit

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / 'contracts/analysis.json').read_text())


@pytest.mark.parametrize('case', CONTRACT['confirmReset'], ids=lambda c: c['name'])
@pytest.mark.parametrize('enabled', [True, False])
def test_confirm_reset_contract(analysis, case, enabled):
    a = analysis
    path = a.song()
    if case['foreign']:
        put_tags(path, bpm=str(case['foreign']['bpm']), key=case['foreign']['key'])
    a.service.scan()
    got = claim(a)
    submit(a, got, [measurement(i, keyConf=case['confidence'], bpmConf=case['confidence'], bpm=66)
                    for i in got['job']['input']['items']])
    a.config.write_analysis_tags = enabled
    before = path.read_bytes()
    ok, fixed = a.service.fix('Album/song.mp3', path, 0, {'key': '5A', 'bpm': 66}, 'owner')
    assert ok and fixed['fixed'] == {'key': '5A', 'bpm': 66}
    assert all(fixed[f] == {'value': v, 'source': 'fixed', 'estimated': False}
               for f, v in (('key', '5A'), ('bpm', 66)))
    if enabled:
        assert analysis_tags(ID3(path))['key'] == '5A'
        assert analysis_tags(ID3(path))['bpm'] == 66
        assert a.repo.tag_fields('Album/song.mp3') == ['bpm', 'key']
    else:
        assert path.read_bytes() == before
    # The exact reset used by both "Undo" and "Use automatic".
    ok, reset = a.service.fix('Album/song.mp3', path, fixed['rev'], {'key': None, 'bpm': None}, 'owner')
    assert ok and reset['rev'] == 2
    for field in ('key', 'bpm'):
        expected = (case['foreign'] or {'key': '5A', 'bpm': 66})[field]
        assert reset[field] == {'value': expected, 'source': case['resetSource'], 'estimated': case['estimated']}
    if enabled:
        tags = analysis_tags(ID3(path))
        for field in ('key', 'bpm'):
            assert tags[field] == (case['writtenAfterReset'] or {}).get(field)
        assert tags['tag_owner'] == ('krobi' if case['confidence'] == 1 and not case['foreign'] else None)
        assert a.service.scan() == 0
    else:
        assert path.read_bytes() == before


def test_confirm_one_field_preserves_sibling_ownership(analysis):
    a = analysis
    a.config.write_analysis_tags = True
    path = a.song(); a.service.scan(); submit(a, claim(a))
    assert a.service.fix('Album/song.mp3', path, 0, {'key': '2A'}, 'owner')[0]
    assert a.repo.tag_fields('Album/song.mp3') == ['bpm', 'key']
    assert a.service.view('Album/song.mp3', path)['bpm']['source'] == 'computed'
    assert a.service.fix('Album/song.mp3', path, 1, {'key': None}, 'owner')[1]['key']['source'] == 'computed'
    assert analysis_tags(ID3(path)) == {'key': '5A', 'bpm': 123.5, 'tag_owner': 'krobi'}


def estimated_songs(a):
    for name in ('z.mp3', 'b.mp3', 'a.mp3'):
        a.song(name)
    a.service.scan()
    got = claim(a)
    submit(a, got, [measurement(i, keyConf=0, bpmConf=0) for i in got['job']['input']['items']])


def test_estimates_scope_order_paging_and_confirmed_cursor(analysis, api):
    a = analysis
    estimated_songs(a)
    a.service.fix(api.rel, api.path, 0, {'key': '5A', 'bpm': 66}, 'owner')
    api.app.dependency_overrides[get_library_scope] = lambda: LibraryScope()
    first = api.client.get('/api/analysis/estimates?limit=1')
    assert first.status_code == 200, first.text
    one = first.json()
    assert len(one['rows']) == 1 and one['after'] == one['rows'][0]['relPath']
    row = one['rows'][0]
    assert set(row) == {'relPath', 'title', 'artist', 'album', 'key', 'keyEstimated', 'keySource',
                        'bpm', 'bpmEstimated', 'bpmSource', 'keyConfidence', 'bpmConfidence', 'rev'}
    assert row['keyEstimated'] and row['bpmEstimated'] and row['keySource'] == row['bpmSource'] == 'computed'
    confirmed = api.client.put('/api/analysis/' + row['relPath'] + '/fixed', json={'rev': row['rev'], 'key': row['key'], 'bpm': row['bpm']})
    assert confirmed.status_code == 200
    second = api.client.get('/api/analysis/estimates', params={'after': one['after'], 'limit': 1}).json()
    third = api.client.get('/api/analysis/estimates', params={'after': second['after'], 'limit': 1}).json()
    assert third['after'] is None
    rels = [r['relPath'] for p in (one, second, third) for r in p['rows']]
    assert len(set(rels)) == 3 and rels == sorted(rels)
    api.app.dependency_overrides[get_library_scope] = lambda: LibraryScope(frozenset({rels[2]}))
    scoped = api.client.get('/api/analysis/estimates').json()
    assert [r['relPath'] for r in scoped['rows']] == [rels[2]] and scoped['after'] is None
    assert api.client.get('/api/analysis/estimates?limit=0').status_code == 422
    assert api.client.get('/api/analysis/estimates?after=unknown').status_code == 422
    def member():
        raise HTTPException(403, 'owner-required')
    api.app.dependency_overrides[require_owner] = member
    assert api.client.get('/api/analysis/estimates').status_code == 403


def test_estimate_summary_counts_effective_fields_and_etag(analysis, api):
    a = analysis
    estimated_songs(a)
    first = api.client.get('/api/analysis/summary')
    assert first.json()['estimated'] == {'songs': 4, 'keys': 4, 'bpms': 4}
    assert a.service.fix('Album/a.mp3', a.config.base_music_dir / 'Album/a.mp3', 0, {'key': '5A'}, 'owner')[0]
    next_ = api.client.get('/api/analysis/summary', headers={'If-None-Match': first.headers['etag']})
    assert next_.status_code == 200
    assert next_.json()['estimated'] == {'songs': 4, 'keys': 3, 'bpms': 4}
    assert a.service.fix('Album/a.mp3', a.config.base_music_dir / 'Album/a.mp3', 1, {'bpm': 123.5}, 'owner')[0]
    assert api.client.get('/api/analysis/summary').json()['estimated'] == {'songs': 3, 'keys': 3, 'bpms': 3}


def test_review_uses_artist_title_and_path_tie_breaker(analysis):
    from mutagen.id3 import TIT2, TPE1
    a = analysis
    for filename, artist, title in [('z.mp3', 'alpha', 'second'), ('a.mp3', 'Zulu', 'first'),
                                    ('b.mp3', 'Alpha', 'first'), ('c.mp3', 'alpha', 'first')]:
        path = a.song(filename)
        tags = ID3(); tags.add(TIT2(encoding=3, text=[title])); tags.add(TPE1(encoding=3, text=[artist])); tags.save(path)
    a.service.scan(); got = claim(a)
    submit(a, got, [measurement(i, keyConf=0, bpmConf=0) for i in got['job']['input']['items']])
    seen, cursor = [], None
    while True:
        page = a.service.estimates(cursor, 1, LibraryScope())
        seen += [r['relPath'] for r in page['rows']]
        cursor = page['after']
        if cursor is None:
            break
    assert seen == ['Album/b.mp3', 'Album/c.mp3', 'Album/z.mp3', 'Album/a.mp3']


def test_external_edit_after_correction_is_not_replaced_by_an_old_backup(analysis):
    from mutagen.id3 import TKEY
    a = analysis
    path = a.song(); put_tags(path, key='2A')
    a.config.write_analysis_tags = True
    a.service.scan(); submit(a, claim(a))
    a.service.fix('Album/song.mp3', path, 0, {'key': '5A'}, 'owner')
    tags = ID3(path); tags.add(TKEY(encoding=3, text=['9B'])); tags.save(path)
    ok, view = a.service.fix('Album/song.mp3', path, 1, {'key': None}, 'owner')
    assert ok and view['key'] == {'value': '9B', 'source': 'tag', 'estimated': False}
    assert analysis_tags(ID3(path))['key'] == '9B'


def test_reanalysis_advances_rev_and_rejects_a_stale_confirmation(analysis, api):
    a = analysis
    a.service.scan(); got = claim(a)
    submit(a, got, [measurement(i, keyConf=0, bpmConf=0) for i in got['job']['input']['items']])
    previous = api.client.get('/api/analysis/' + api.rel).json()
    # A file replacement can return a newer estimate while the sheet is open.
    with a.repo.connection() as db:
        db.execute('UPDATE track_analysis SET engine_version=0 WHERE rel_path=?', (api.rel,))
    a.service.runs.start('refresh', 'outdated', 'song', [api.rel], 'owner')
    got = claim(a)
    submit(a, got, [measurement(i, key='9B', keyConf=0, bpmConf=0) for i in got['job']['input']['items']])
    conflict = api.client.put('/api/analysis/' + api.rel + '/fixed', json={'rev': previous['rev'], 'key': previous['computed']['key']})
    assert conflict.status_code == 409
    assert conflict.json()['computed']['key'] == '9B'
    assert conflict.json()['fixed']['key'] is None


def test_unanalyzed_correction_ownership_yields_to_an_external_tag_edit(analysis):
    from mutagen.id3 import TKEY
    a = analysis
    path = a.song(); put_tags(path, key='2A')
    a.config.write_analysis_tags = True
    assert a.service.fix('Album/song.mp3', path, 0, {'key': '5A'}, 'owner')[0]
    tags = ID3(path); tags.add(TKEY(encoding=3, text=['9B'])); tags.save(path)
    assert a.service.fix('Album/song.mp3', path, 1, {'key': None}, 'owner')[1]['key']['value'] == '9B'
    # A later correction must back up the person's latest tag, not the old one.
    a.service.fix('Album/song.mp3', path, 2, {'key': '5A'}, 'owner')
    assert a.service.fix('Album/song.mp3', path, 3, {'key': None}, 'owner')[1]['key']['value'] == '9B'


@pytest.mark.parametrize('bpm,status', [(20, 200), (20.1, 200), (300, 200), (19.9, 422), (300.1, 422)])
def test_fixed_bpm_accepts_the_tags_field_range(api, bpm, status):
    response = api.client.put('/api/analysis/' + api.rel + '/fixed', json={'rev': 0, 'bpm': bpm})
    assert response.status_code == status
    if status == 200:
        assert response.json()['fixed']['bpm'] == bpm


def test_computed_estimate_flags_survive_a_correction(analysis, api):
    a = analysis
    a.service.scan()
    got = claim(a)
    submit(a, got, [measurement(i, keyConf=0, bpmConf=0) for i in got['job']['input']['items']])
    response = api.client.put('/api/analysis/' + api.rel + '/fixed', json={'rev': 0, 'key': '2A', 'bpm': 132})
    assert response.status_code == 200
    view = response.json()
    assert not view['key']['estimated'] and not view['bpm']['estimated']
    assert view['computed']['keyEstimated'] and view['computed']['bpmEstimated']
