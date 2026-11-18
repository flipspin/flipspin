"""Matching is read-only; the approved subset is one undoable, revision-fenced edit."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TSRC

from tests.integration.test_analysis import house as house
from app.domains.metadata.matching import Candidate
from app.domains.metadata import tagwriter
from app.exceptions import ExternalAPIError

RECORDING = '11111111-1111-1111-1111-111111111111'
RELEASE = '22222222-2222-2222-2222-222222222222'
OTHER = '33333333-3333-3333-3333-333333333333'


@pytest.fixture
def match(house, monkeypatch):
    h = house
    tags = ID3(); tags.add(TIT2(text=['Song'])); tags.add(TPE1(text=['Artist'])); tags.add(TALB(text=['Album'])); tags.add(TSRC(text=['USAAA0000001'])); tags.save(h.path)
    provider = h.container.get_musicbrainz_repository()
    duration = h.container.get_music_repository().read_tags(h.path)['duration']
    recording = {'id': RECORDING, 'title': 'Song', 'length': duration * 1000,
                 'artist-credit': [{'name': 'Artist'}], 'isrcs': ['USAAA0000001']}
    release = {'id': RELEASE, 'title': 'Album', 'date': '1979-01-01', 'country': 'GB',
               'artist-credit': [{'name': 'Artist'}], 'media': [{'position': 1, 'tracks': [{'position': 1, 'recording': recording}]}]}
    monkeypatch.setattr(provider, 'search_recordings', lambda *args: [Candidate('Song', 'musicbrainz', RECORDING, recording_mbid=RECORDING)])
    monkeypatch.setattr(provider, 'search_candidates', lambda *args: [Candidate('Song', 'musicbrainz', RECORDING, recording_mbid=RECORDING)])
    monkeypatch.setattr(provider, 'lookup_recording', lambda *args: recording)
    monkeypatch.setattr(provider, 'search_releases', lambda *args, **kwargs: [{'id': RELEASE}])
    monkeypatch.setattr(provider, 'lookup_release', lambda *args: release)
    h.match = h.container.get_match_service()
    h.provider, h.recording, h.release = provider, recording, release
    return h


def start(h, body=None):
    response = h.admin.post('/api/library/match', json=body or {'albumKey': 'Album'})
    assert response.status_code == 202, response.text
    job_id = response.json()['jobId']
    result = h.admin.get('/api/library/match/' + job_id)
    assert result.status_code == 200, result.text
    return job_id, result.json()


def plan(h, job, fields, candidate=0):
    return h.admin.post(f'/api/library/match/{job}/plan', json={'rows': [
        {'relPath': 'Album/song.mp3', 'candidate': candidate, 'fields': fields}]})


def apply(h, proposal):
    return h.admin.post('/api/library/edits/' + proposal['planId'] + '/apply', json={'planHash': proposal['planHash']})


def test_readonly_strong_diff_subset_apply_ids_provenance_and_undo(match):
    h = match
    before = h.path.read_bytes()
    job, result = start(h)
    assert result['state'] == 'succeeded' and result['groups']['strong'] == [0]
    candidate = result['candidates'][0]
    assert candidate['band'] == 'strong' and '1 ISRC hits' in candidate['reasons']
    assert 'distance' not in candidate and '%' not in str(candidate['reasons'])
    diff = candidate['files'][0]['fields']
    assert diff['year'] == {'now': None, 'new': 1979}
    assert h.path.read_bytes() == before
    proposal = plan(h, job, ['year', 'mbRecording', 'mbRelease']).json()
    assert h.path.read_bytes() == before
    assert h.match.edits.get(proposal['planId'])['state'] == 'planned'
    assert apply(h, {**proposal, 'planHash': 'wrong'}).status_code == 409
    first = apply(h, proposal)
    assert first.status_code == 202, first.text
    repeated = apply(h, proposal)
    assert repeated.status_code == 200 and repeated.json()['applied'] == 1
    entry = h.match.edits.get(proposal['planId'])
    assert entry['kind'] == 'match-apply' and len(entry['rows']) == 1
    fields = tagwriter.read(h.path)['fields']
    assert fields['year'] == 1979 and fields['mbRecording'] == RECORDING and fields['mbRelease'] == RELEASE
    assert fields.get('trackNumber') is None  # Unselected fields stay untouched.
    with h.match.repository.connection() as db:
        assert db.execute('SELECT mb_source FROM track_identity').fetchone()[0] == 'match@' + proposal['planId']
    assert h.admin.post('/api/library/edits/' + proposal['planId'] + '/undo').status_code == 202
    assert tagwriter.read(h.path)['fields'].get('mbRecording') is None
    with h.match.repository.connection() as db:
        assert db.execute('SELECT count(*) FROM track_identity').fetchone()[0] == 0


def test_stale_since_preview_and_plan_partial_counts(match):
    h = match
    second = h.path.with_name('second.mp3'); second.write_bytes(h.path.read_bytes())
    recording2 = {**h.recording, 'id': OTHER, 'title': 'Second'}
    h.release['media'][0]['tracks'].append({'position': 2, 'recording': recording2})
    tags = ID3(second); tags.setall('TIT2', [TIT2(text=['Second'])]); tags.save(second)
    job, result = start(h)
    h.match.provider.lookup_release = lambda *args: h.release
    selections = [{'relPath': f['relPath'], 'candidate': 0, 'fields': ['mbRecording']} for f in result['candidates'][0]['files']]
    tags = ID3(h.path); tags.setall('TIT2', [TIT2(text=['Outside'])]); tags.save(h.path)
    outside = h.path.read_bytes()
    response = h.admin.post(f'/api/library/match/{job}/plan', json={'rows': selections})
    assert response.status_code == 200, response.text
    assert any(r['state'] == 'changed-since' for r in response.json()['rows'])
    assert apply(h, response.json()).status_code == 202
    result = apply(h, response.json()).json()
    assert result['skipped'] == result['applied'] == 1 and result['state'] == 'partial'
    assert h.path.read_bytes() == outside
    # A change after planning is fenced as well.
    job, _ = start(h, {'relPaths': ['Album/song.mp3']})
    proposal = plan(h, job, ['mbRecording']).json()
    tags = ID3(h.path); tags.setall('TIT2', [TIT2(text=['Later'])]); tags.save(h.path)
    assert apply(h, proposal).status_code == 202
    assert apply(h, proposal).json()['skipped'] == 1


def test_gates_scope_validation_link_and_free_text(match, monkeypatch):
    h = match
    for method, url, body in [('post', '/api/library/match', {'albumKey': 'Album'}),
                              ('get', '/api/library/match/missing', None), ('delete', '/api/library/match/missing', None),
                              ('post', '/api/library/match/missing/plan', {'rows': []}),
                              ('post', '/api/library/edits/missing/apply', {'planHash': 'x'})]:
        response = getattr(h.member, method)(url, **({'json': body} if body else {}))
        assert response.status_code == 403
    for body in ({'relPaths': ['../bad.mp3']}, {'albumKey': '../bad'}, {'relPaths': ['Album/song.mp3'] * 201},
                 {'albumKey': 'Album', 'relPaths': ['Album/song.mp3']},
                 {'albumKey': 'Album', 'link': 'https://example.com/release/' + RELEASE},
                 {'albumKey': 'Album', 'link': 'https://musicbrainz.org/recording/' + RECORDING}):
        assert h.admin.post('/api/library/match', json=body).status_code in (404, 422)
    query = []
    monkeypatch.setattr(h.provider, 'search_candidates', lambda text: query.append(text) or [])
    _, view = start(h, {'relPaths': ['Album/song.mp3'], 'query': 'Free search'})
    assert query == ['Free search'] and view['candidates'] == []
    job, _ = start(h, {'relPaths': ['Album/song.mp3'], 'link': 'https://musicbrainz.org/recording/' + RECORDING})
    for fields, candidate in [(['analysisMarker'], 0), (['mbRecording'], 5), (['mbRecording', 'mbRecording'], 0)]:
        assert plan(h, job, fields, candidate).status_code == 422
    proposal = plan(h, job, ['mbRecording']).json()
    monkeypatch.setattr(h.match, 'now', lambda: h.match.edits.get(proposal['planId'])['created_at'] + 901)
    assert apply(h, proposal).json()['detail']['reason'] == 'plan-expired'


def test_review_gap_weak_count_and_duration_veto(match, monkeypatch):
    h = match
    second = deepcopy(h.release); second['id'] = OTHER
    monkeypatch.setattr(h.provider, 'search_releases', lambda *a, **kw: [{'id': RELEASE}, {'id': OTHER}])
    monkeypatch.setattr(h.provider, 'lookup_release', lambda mbid: h.release if mbid == RELEASE else second)
    _, view = start(h)
    assert [c['band'] for c in view['candidates']] == ['review', 'review']
    h.recording['length'] += 60000
    second['media'][0]['tracks'][0]['recording']['length'] += 60000
    _, view = start(h)
    assert all(c['band'] != 'strong' for c in view['candidates'])
    h.release['media'][0]['tracks'].append({'position': 2, 'recording': {**h.recording, 'id': OTHER}})
    _, view = start(h)
    assert all(c['band'] != 'strong' for c in view['candidates'])
    h.recording['title'] = 'Completely unrelated'; h.recording['artist-credit'] = [{'name': 'Other artist'}]
    _, view = start(h, {'relPaths': ['Album/song.mp3']})
    assert view['candidates'][0]['band'] == 'weak'


def test_dedup_one_running_cancel_and_provider_busy(match, monkeypatch):
    h = match
    job, created = h.match.start({'albumKey': 'Album'}, 'owner')
    same, created_again = h.match.start({'albumKey': 'Album'}, 'owner')
    assert created and not created_again and job == same
    assert h.match.start({'relPaths': ['Album/song.mp3']}, 'owner') == (job, False)
    with pytest.raises(tagwriter.TagError, match='busy'):
        h.match.start({'relPaths': ['Album/song.mp3'], 'query': 'Different search'}, 'owner')
    started, finish = Event(), Event()
    def slow(*args):
        started.set(); assert finish.wait(5)
        return h.release
    monkeypatch.setattr(h.provider, 'lookup_release', slow)
    with ThreadPoolExecutor() as pool:
        future = pool.submit(h.match.run, job)
        assert started.wait(5)
        assert h.admin.delete('/api/library/match/' + job).json()['state'] == 'cancelled'
        finish.set(); future.result()
    assert h.match.view(job)['state'] == 'cancelled'
    assert h.match.tracker.get_progress(job).succeeded == 0
    def busy(*args, **kwargs):
        raise ExternalAPIError('busy', api_name='musicbrainz', details={'status': 503})
    monkeypatch.setattr(h.provider, 'search_releases', busy)
    _, view = start(h)
    assert view['state'] == 'failed' and view['errors'][0]['reason'] == 'provider-busy'


def test_shared_repository_instance(match):
    assert match.match.provider is match.container.get_musicbrainz_repository()
    assert match.match.provider is match.container.get_provider_registry().instance('musicbrainz').repository


def test_outside_symlink_since_preview_is_skipped_without_touching_target(match):
    h = match
    job, _ = start(h)
    proposal = plan(h, job, ['mbRecording']).json()
    outside = h.container.config.base_music_dir.parent / 'outside.mp3'
    outside.write_bytes(h.path.read_bytes())
    original = outside.read_bytes()
    h.path.unlink(); h.path.symlink_to(outside)
    assert apply(h, proposal).status_code == 202
    assert apply(h, proposal).json()['skipped'] == 1
    assert outside.read_bytes() == original


def test_proposals_survive_new_service_and_retention_is_bounded(match, monkeypatch):
    from app.domains.music.match_service import MatchService
    h = match
    job, original = start(h)
    service = MatchService(h.match.config, h.match.edits, h.provider, h.match.tracker)
    assert service.view(job) == original
    monkeypatch.setattr(service, 'now', lambda: h.match.now() + 7 * 86400 + 1)
    with pytest.raises(tagwriter.TagError, match='missing'):
        service.view(job)


def test_partial_provider_failure_keeps_other_file_proposal(match, monkeypatch):
    h = match
    second = h.path.with_name('second.mp3'); second.write_bytes(h.path.read_bytes())
    calls = []
    def lookup(mbid):
        calls.append(mbid)
        if len(calls) == 1:
            raise ExternalAPIError('busy', api_name='musicbrainz', details={'status': 503})
        return h.recording
    monkeypatch.setattr(h.provider, 'lookup_recording', lookup)
    _, view = start(h, {'relPaths': ['Album/second.mp3', 'Album/song.mp3']})
    assert view['state'] == 'partial'
    assert len(view['candidates']) == len(view['errors']) == 1
    assert view['candidates'][0]['files'][0]['relPath'] == 'Album/song.mp3'


def test_album_scope_folds_discs_but_does_not_swallow_nested_albums(match):
    h = match
    disc = h.path.parent / 'CD2'; disc.mkdir()
    (disc / 'second.mp3').write_bytes(h.path.read_bytes())
    nested = h.path.parent / 'Another album'; nested.mkdir()
    (nested / 'third.mp3').write_bytes(h.path.read_bytes())
    job, _ = h.match.start({'albumKey': 'Album'}, 'owner')
    paths = [f['relPath'] for f in h.match.stored(job)['request']['files']]
    assert paths == ['Album/CD2∕second.mp3', 'Album/song.mp3']
    h.match.cancel(job)


def test_store_failure_after_replace_is_recovered_without_rewriting_and_keeps_source(match, monkeypatch):
    h = match
    job, _ = start(h)
    proposal = plan(h, job, ['mbRecording']).json()
    original = h.match.edits.synced
    def failed(*args, **kwargs):
        raise OSError('store unavailable')
    monkeypatch.setattr(h.match.edits, 'synced', failed)
    assert apply(h, proposal).status_code == 202
    assert apply(h, proposal).json()['state'] == 'interrupted'
    written = h.path.read_bytes()
    monkeypatch.setattr(h.match.edits, 'synced', original)
    h.match.edits.recover_entry(proposal['planId'])
    assert h.path.read_bytes() == written
    assert apply(h, proposal).json()['applied'] == 1
    with h.match.repository.connection() as db:
        assert db.execute('SELECT mb_source FROM track_identity').fetchone()[0] == 'match@' + proposal['planId']


def test_conflicting_existing_identity_needs_review_even_with_matching_text(match):
    h = match
    h.recording['isrcs'] = ['USBBB0000002']
    _, view = start(h, {'relPaths': ['Album/song.mp3']})
    candidate = view['candidates'][0]
    assert candidate['band'] == 'review'
    assert 'ISRC differs' in candidate['reasons']
