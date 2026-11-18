"""Owner gates, optimistic HTTP edits, receipts, batch history and frozen alias."""
from concurrent.futures import ThreadPoolExecutor

from mutagen.id3 import ID3, TIT2

from tests.integration.test_analysis import house as house, CLAIM, result_item
from tests.integration.test_wire_snapshots import assert_matches_snapshot

URL = '/api/library/tags/Album/song.mp3'


def test_rev_conflict_current_values_and_clear(house):
    h = house
    read = h.admin.get(URL)
    assert read.status_code == 200 and read.headers['etag'] == read.json()['rev']
    old = read.json()['rev']
    tags = ID3(); tags.add(TIT2(text=['Outside'])); tags.save(h.path)
    before = h.path.read_bytes()
    conflict = h.admin.put(URL, headers={'If-Match': old}, json={'set': {'title': 'Lost'}})
    assert conflict.status_code == 409
    assert conflict.json()['detail']['reason'] == 'changed-since'
    assert conflict.json()['detail']['current']['fields']['title'] == 'Outside'
    assert h.path.read_bytes() == before
    snapshot = conflict.json(); snapshot['detail']['current']['rev'] = '<rev>'
    assert_matches_snapshot('library-tags-conflict', snapshot)
    rev = h.admin.get(URL).json()['rev']
    result = h.admin.put(URL, json={'rev': rev, 'set': {'genre': 'Rock'}})
    assert result.status_code == 200 and result.json()['editId']
    clear = h.admin.put(URL, json={'rev': result.json()['rev'], 'set': {'genre': None}})
    assert clear.status_code == 200 and 'TCON' not in ID3(h.path)
    assert h.admin.put(URL, json={'set': {'title': 'Missing rev'}}).status_code == 422
    for fields in ({'year': 10000}, {'title': 'x'*1001}, {'genre': 'bad\n'}, {'discNumber': -1}, {'analysisMarker': 'fake'}):
        assert h.admin.put(URL, json={'rev': clear.json()['rev'], 'set': fields}).status_code == 422


def test_all_routes_member_gates_and_missing_scope(house):
    h = house
    rev = h.admin.get(URL).json()['rev']
    assert h.member.get(URL).status_code == 404
    assert h.member.get('/api/library/tags/Absent/missing.mp3').status_code == 404
    h.container.get_user_track_store().add_many(h.member_id, ['Album/song.mp3'])
    assert h.member.get(URL).status_code == 200
    assert h.member.put(URL, json={'rev': rev, 'set': {'title': 'No'}}).status_code == 403
    body = {'items': [{'relPath': 'Album/song.mp3', 'rev': rev}], 'set': {'genre': 'No'}}
    assert h.member.post('/api/library/tags/batch', json=body).status_code == 403
    assert h.member.post('/api/update-tags', json={'path': str(h.path), 'title': 'No'}).status_code == 403
    assert h.member.get('/api/library/edits').status_code == 403
    assert h.member.get('/api/library/edits/missing').status_code == 403
    assert h.member.post('/api/library/edits/missing/undo').status_code == 403
    assert h.admin.get('/api/library/tags/../outside.mp3').status_code == 404
    assert h.admin.get('/api/library/tags/Absent/missing.mp3').status_code == 404


def test_put_signature_refresh_does_not_requeue_analysis(house):
    h = house
    h.service.scan()
    claim = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    h.helper.post('/api/helpers/jobs/' + claim['job']['id'] + '/result', json={
        'lease': claim['lease'], 'items': [result_item(i) for i in claim['job']['input']['items']]})
    rev = h.admin.get(URL).json()['rev']
    result = h.admin.put(URL, headers={'If-Match': rev}, json={'set': {'title': 'Edited'}})
    assert result.status_code == 200
    assert h.service.scan() == 0
    row = h.service.repository.get('Album/song.mp3')
    assert (row['size'], row['mtime_ns']) == (h.path.stat().st_size, h.path.stat().st_mtime_ns)


def test_batch_partial_undo_double_tap_and_receipts(house):
    h = house
    second = h.path.with_name('second.mp3'); second.write_bytes(h.path.read_bytes())
    rev = h.admin.get(URL).json()['rev']
    items = [{'relPath': 'Album/song.mp3', 'rev': rev}, {'relPath': 'Album/second.mp3', 'rev': 'stale'}]
    response = h.admin.post('/api/library/tags/batch', headers={'Idempotency-Key': 'batch'}, json={'items': items, 'set': {'title': 'Bulk'}})
    assert response.status_code == 202, response.text
    assert_matches_snapshot('library-tags-batch', {**response.json(), 'editId': '<edit-id>', 'progressId': '<progress-id>'})
    edit_id = response.json()['editId']
    repeat = h.admin.post('/api/library/tags/batch', headers={'Idempotency-Key': 'batch'}, json={'items': items, 'set': {'title': 'Bulk'}})
    assert repeat.status_code == 202 and repeat.json() == response.json()
    detail = h.admin.get('/api/library/edits/' + edit_id).json()
    assert detail['state'] == 'partial'
    assert detail['rows'][1]['reason'] == 'changed-since'
    assert all('refs_snapshot' not in r for r in detail['rows'])
    job = h.container.get_jobs().get(response.json()['progressId'])
    assert job['kind'] == 'library-edit' and job['state'] == 'partial'
    history = h.admin.get('/api/library/edits')
    assert h.admin.get('/api/library/edits', headers={'If-None-Match': history.headers['etag']}).status_code == 304
    assert history.json()['entries'][0]['id'] == edit_id
    def undo():
        return h.admin.post('/api/library/edits/' + edit_id + '/undo')
    with ThreadPoolExecutor(2) as pool:
        calls = [pool.submit(undo) for _ in range(2)]; responses = [c.result() for c in calls]
    assert all(r.status_code == 202 for r in responses)
    assert responses[0].json() == responses[1].json()
    assert_matches_snapshot('library-tags-undo', {**responses[0].json(), 'editId': '<edit-id>'})
    assert 'TIT2' not in ID3(h.path)
    assert h.admin.get('/api/library/edits/' + edit_id).json()['state'] == 'undone'


def test_bulk_genre_detail_keeps_the_existing_wire_and_only_journals_touched_fields(house):
    h = house
    second = h.path.with_name('second.mp3')
    second.write_bytes(h.path.read_bytes())
    paths = ['Album/song.mp3', 'Album/second.mp3']
    views = [h.admin.get('/api/library/tags/' + path).json() for path in paths]
    response = h.admin.post('/api/library/tags/batch', json={
        'items': [{'relPath': path, 'rev': view['rev']} for path, view in zip(paths, views, strict=True)],
        'set': {'genre': 'Synth-pop'},
    })
    assert response.status_code == 202
    edit_id = response.json()['editId']
    detail = h.admin.get('/api/library/edits/' + edit_id)
    assert detail.status_code == 200
    raw = h.container.get_tag_edits().get(edit_id)
    expected = {**raw, 'rows': [{k: v for k, v in row.items() if k != 'refs_snapshot'} for row in raw['rows']]}
    assert detail.json() == expected
    assert detail.json()['kind'] == 'tags-batch'
    assert len(detail.json()['rows']) == 2
    for row in detail.json()['rows']:
        assert row['state'] == 'applied'
        assert row['fields_after'] == {'genre': 'Synth-pop'}
        assert set(row['fields_before']) == {'genre'}
    for path, view in zip(paths, views, strict=True):
        after = h.admin.get('/api/library/tags/' + path).json()
        assert after['fields']['title'] == view['fields']['title']
    too_many = [{'relPath': f'Album/{idx}.mp3', 'rev': 'rev'} for idx in range(501)]
    assert h.admin.post('/api/library/tags/batch', json={'items': too_many, 'set': {'genre': 'Pop'}}).status_code == 422


def test_put_receipt_noop_and_alias_wire_snapshots(house):
    h = house
    rev = h.admin.get(URL).json()['rev']
    body = {'set': {'title': 'Edited'}, 'rev': rev}
    first = h.admin.put(URL, headers={'Idempotency-Key': 'single'}, json=body)
    repeat = h.admin.put(URL, headers={'Idempotency-Key': 'single'}, json=body)
    assert first.status_code == repeat.status_code == 200 and first.json() == repeat.json()
    assert h.admin.put(URL, headers={'Idempotency-Key': 'single'}, json={**body, 'set': {'title': 'Other'}}).status_code == 422
    assert h.admin.put(URL, json={'rev': first.json()['rev'], 'set': {'title': 'Edited'}}).json()['editId'] is None
    view = h.admin.get(URL).json(); view['rev'] = '<rev>'
    assert_matches_snapshot('library-tags', view)
    assert_matches_snapshot('library-tags-edit', {**first.json(), 'editId': '<edit-id>', 'rev': '<rev>'})
    alias = h.admin.post('/api/update-tags', json={'path': str(h.path), 'title': 'Alias'})
    assert alias.status_code == 200 and alias.headers['deprecation'] == 'true'
    assert_matches_snapshot('update-tags', {**alias.json(), 'path': '/music/Album/song.mp3'})
    assert ID3(h.path)['TIT2'].text == ['Alias']


def test_move_retag_keeps_analysis_signature(house):
    h = house
    h.service.scan()
    claim = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    h.helper.post('/api/helpers/jobs/' + claim['job']['id'] + '/result', json={
        'lease': claim['lease'], 'items': [result_item(i) for i in claim['job']['input']['items']]})
    target = h.path.parent.with_name('Moved'); target.mkdir()
    destination = h.container.get_track_relocator().move(h.path, target, album_title='Moved', track_number=2)
    assert h.service.scan() == 0
    row = h.service.repository.get('Moved/song.mp3')
    assert (row['size'], row['mtime_ns']) == (destination.stat().st_size, destination.stat().st_mtime_ns)
    assert ID3(destination)['TALB'].text == ['Moved']


def test_id3v22_read_only_reason_and_rejected_http_edit_preserve_bytes(house):
    from app.domains.metadata import tagwriter
    h = house
    block = b'TT2\x00\x00\x04\x00OldXYZ\x00\x00\x0fPRIVATE-PAYLOAD'
    original = b'ID3\x02\x00\x00' + tagwriter.packed_size(len(block)) + block + h.path.read_bytes()
    h.path.write_bytes(original)
    response = h.admin.get(URL)
    assert response.status_code == 200
    view = response.json()
    assert view['writable'] is False and view['reason'] == 'unsupported-format'
    assert view['fields']['title'] == 'Old'
    attempted = h.admin.put(URL, json={'rev': view['rev'], 'set': {'title': 'New'}})
    assert attempted.status_code == 409
    assert attempted.json()['detail']['reason'] == 'unsupported-format'
    assert h.path.read_bytes() == original
