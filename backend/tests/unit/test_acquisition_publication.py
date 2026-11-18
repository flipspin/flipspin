"""Atomic publication, account links, and completion notifications."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.downloads.core import ResolvedVideo
from app.infra.identity import LOCAL_OWNER, Principal
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import ANA, BETO, body, submit

pipeline = fixtures.pipeline


def test_batch_refreshes_once_and_listener_errors_never_fail_import(pipeline):
    pipeline.music = Mock()
    legacy, contextual, after_failure = [], [], []
    broken = Mock(side_effect=TypeError('listener failed'))
    pipeline.engine.completion_listeners = [
        legacy.append, broken,
        lambda paths, *, origin: contextual.append((paths, origin)), after_failure.append,
    ]
    request = submit(pipeline, body(3))
    results = asyncio.run(pipeline.run(request['id']))
    paths = [r.file_path for r in results]
    assert all(r.success and r.file_path.is_file() for r in results)
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'
    notified = [call[0] for call in contextual]
    assert {p for paths in notified for p in paths} == set(paths)
    assert all(len(paths) == 1 for paths in notified)
    assert legacy == after_failure == notified
    assert contextual == [(paths, 'deezer') for paths in notified]
    assert broken.call_count == 3
    assert all(call.kwargs == {'origin': 'deezer', 'batch_total': 3} for call in broken.call_args_list)
    pipeline.music.refresh_folders.assert_called_once_with([paths[0].parent])
    pipeline.music.invalidate_scan.assert_not_called()


def test_existing_files_do_not_refresh_or_notify(pipeline):
    request = submit(pipeline)
    asyncio.run(pipeline.run(request['id']))
    pipeline.music = Mock()
    listener = Mock()
    pipeline.engine.completion_listeners = [listener]
    request = submit(pipeline, body().model_copy(update={'provider_id': 'other'}))
    path = next(pipeline.root.rglob('*.mp3'))
    assert asyncio.run(pipeline.run(request['id'], hits={0: path}))[0].already_present
    listener.assert_not_called()
    pipeline.music.invalidate_scan.assert_not_called()


def test_completion_passes_batch_total_and_preserves_older_listener_signatures(pipeline):
    pipeline.music = Mock()
    legacy, contextual, totals, after_failure = [], [], [], []
    broken = Mock(side_effect=TypeError('listener failed'))
    pipeline.engine.completion_listeners = [
        legacy.append,
        lambda paths, *, origin: contextual.append((paths, origin)),
        lambda paths, *, origin, batch_total: totals.append((paths, origin, batch_total)),
        broken, after_failure.append,
    ]
    paths = [pipeline.root / 'landed.wav']
    pipeline.complete_batch(paths, origin='upload', batch_total=40, refresh=False)
    assert legacy == after_failure == [paths]
    assert contextual == [(paths, 'upload')]
    assert totals == [(paths, 'upload', 40)]
    broken.assert_called_once_with(paths, origin='upload', batch_total=40)
    pipeline.music.invalidate_scan.assert_not_called()
    pipeline.refresh_batch()
    pipeline.music.invalidate_scan.assert_called_once_with('mutation')


@pytest.mark.parametrize('principal', [ANA, Principal('owner', 'Owner', 'owner')])
def test_catalog_replacement_recycles_owner_file_or_swaps_member_reference(pipeline, principal):
    from app.domains.browse.acquisition import AcquireRequest
    from app.infra.progress import ProgressTracker
    pipeline.tracker = ProgressTracker(pipeline.ledger)
    old = pipeline.root / 'Album' / 'Old.mp3'
    old.parent.mkdir()
    old.write_bytes(b'old recording')
    pipeline.user_tracks.add_many(principal.user_id, ['Album/Old.mp3'])
    relocator = Mock()
    relocator.library_file.return_value = old
    def replace(old_path, new_path):
        assert [p.read_bytes() for p in pipeline.recycle.iterdir()] == [b'old recording']
        old_path.unlink()
    relocator.replace.side_effect = replace
    data = AcquireRequest(tracks=[{'title': 'Fresh', 'artistName': 'Artist', 'albumTitle': 'Album', 'replaces': str(old)}])
    async def scenario():
        await pipeline.catalog(data, principal, relocator=relocator)
        async def finished():
            while pipeline.store.list(principal.user_id)[0]['state'] != 'completo':
                await asyncio.sleep(0.01)
        await asyncio.wait_for(finished(), 2)
    asyncio.run(scenario())
    assert pipeline.user_tracks.get(principal.user_id, 'Album/Fresh.mp3') is not None
    if principal.is_owner:
        assert not old.exists()
        relocator.replace.assert_called_once()
    else:
        assert old.read_bytes() == b'old recording'
        assert pipeline.user_tracks.get(principal.user_id, 'Album/Old.mp3') is None
        relocator.replace.assert_not_called()


@pytest.mark.parametrize('changed_path,dedupe', [(False, False), (True, False), (True, True)])
def test_readd_preserves_date_and_repoints_missing_references(pipeline, monkeypatch, changed_path, dedupe):
    from datetime import datetime

    monkeypatch.setattr('app.domains.user_library.store.utc_now_iso', lambda: '2021-02-03T04:05:06Z')
    original = submit(pipeline)
    result = asyncio.run(pipeline.run(original['id']))[0]
    landed = result.file_path
    rel = landed.relative_to(pipeline.root).as_posix()
    old_rel = 'Former album/old-name.mp3' if changed_path else rel
    if changed_path:
        pipeline.user_tracks.repoint(rel, old_rel)
    pipeline.user_tracks.add_many(BETO.user_id, [old_rel])
    pipeline.user_tracks.update_flags(ANA.user_id, old_rel, liked=True)
    pipeline.user_tracks.set_play_stats(ANA.user_id, old_rel, 7, '2022-01-01T00:00:00Z')
    landed.unlink()
    if dedupe:
        landed.write_bytes(b'another copy of the same recording')
        present_mtime = landed.stat().st_mtime
        pipeline.ownership.lookup_many.side_effect = lambda tracks: [SimpleNamespace(owned=True, match=SimpleNamespace(path=landed))]

    recovery = body().model_copy(update={'provider': 'library-readd', 'provider_id': old_rel})
    request = submit(pipeline, recovery)
    results = asyncio.run(pipeline.run(request['id']))
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'
    new_rel = results[0].file_path.relative_to(pipeline.root).as_posix()
    stamp = datetime.fromisoformat('2021-02-03T04:05:06+00:00').timestamp()
    # A downloaded file takes the original date; a file the nest already had keeps its own.
    assert results[0].file_path.stat().st_mtime == (present_mtime if dedupe else stamp)
    for account in (ANA, BETO):
        rows = pipeline.user_tracks.list_for_user(account.user_id)
        assert len(rows) == 1
        assert rows[0].rel_path == new_rel
        assert rows[0].added_at == '2021-02-03T04:05:06Z'
    row = pipeline.user_tracks.get(ANA.user_id, new_rel)
    assert row.liked and row.play_count == 7 and row.acquired
    # The linker may replay after a crash; it must not reset person data.
    from app.domains.user_library.public import restore
    assert restore(pipeline.user_tracks, ANA, pipeline.root, results[0].file_path,
                   old_rel, acquired=True) == new_rel
    assert pipeline.user_tracks.get(ANA.user_id, new_rel).play_count == 7


def test_readd_cannot_repoint_another_accounts_song(pipeline):
    from app.domains.user_library.public import restore

    old_rel = 'Former album/song.mp3'
    pipeline.user_tracks.add_many(BETO.user_id, [old_rel])
    landed = pipeline.root / 'Album' / 'new.mp3'
    landed.parent.mkdir()
    landed.write_bytes(b'audio')
    with pytest.raises(ValueError, match='missing-library-reference'):
        restore(pipeline.user_tracks, ANA, pipeline.root, landed, old_rel, acquired=True)
    assert pipeline.user_tracks.get(BETO.user_id, old_rel) is not None


@pytest.mark.parametrize('fail_first', [False, True])
def test_export_import_title_and_live_ledger_outcomes(pipeline, monkeypatch, fail_first):
    from app.domains.acquisition import services
    from app.domains.playlists.export_import import ExportImportService
    from app.domains.playlists.routes import ExportTrackRef
    from app.infra.progress import ProgressTracker

    pipeline.tracker = ProgressTracker(pipeline.ledger)
    pipeline.engine._remember_failure = Mock()
    jobs = []
    monkeypatch.setattr('app.domains.playlists.export_import.spawn_background', jobs.append)
    original = services.import_file
    observed = []

    def publish(*args, **kwargs):
        # The second publication sees the first committed, while still running.
        observed.append(pipeline.ledger.get(progress_id))
        if fail_first and len(observed) == 1:
            raise OSError('publication failed')
        return original(*args, **kwargs)

    monkeypatch.setattr(services, 'import_file', publish)

    async def download(tracks, destination, progress_id, **kwargs):
        from app.infra.media_requests import TrackDownloadRequest, TrackMetadata
        requests = [TrackDownloadRequest(search_query=t['name'], destination=destination,
                    metadata=TrackMetadata(title=t['name'])) for t in tracks]
        return await pipeline.legacy(requests, progress_id=progress_id)

    service = SimpleNamespace(config=SimpleNamespace(base_music_dir=pipeline.root), download_spotify_playlist=download)
    progress_id, _ = ExportImportService().start_import(
        'Collection', [ExportTrackRef(title='First'), ExportTrackRef(title='Second')],
        pipeline.root / 'Collection', service, Mock(), pipeline.tracker,
    )
    asyncio.run(jobs[0])
    assert len(observed) == 2
    assert (observed[1]['state'], observed[1]['succeeded'], observed[1]['failed']) == ('running', 0 if fail_first else 1, 1 if fail_first else 0)
    assert pipeline.store.list(LOCAL_OWNER.user_id)[0]['title'] == 'Collection'
    assert pipeline.ledger.get(progress_id)['succeeded'] == (1 if fail_first else 2)
    assert pipeline.ledger.get(progress_id)['state'] == ('partial' if fail_first else 'succeeded')


def test_legacy_title_falls_back_without_parent(pipeline):
    from app.infra.media_requests import TrackDownloadRequest, TrackMetadata
    request = TrackDownloadRequest(search_query='Track', destination=pipeline.root / 'Album',
                                   metadata=TrackMetadata(title='Track'))
    asyncio.run(pipeline.legacy([request]))
    assert pipeline.store.list(LOCAL_OWNER.user_id)[0]['title'] == 'Track'


def test_manual_sources_do_not_share_another_accounts_chosen_audio(pipeline):
    from app.domains.acquisition.models import RetrySelection
    first = submit(pipeline)
    second = submit(pipeline, principal=BETO)
    original = pipeline.engine._resolve_source_url
    async def absent(req):
        return ResolvedVideo(None, 'no results', 'no-results')
    pipeline.engine._resolve_source_url = absent
    async def fail_both():
        await asyncio.gather(pipeline.run(first['id']), pipeline.run(second['id']))
    asyncio.run(fail_both())
    selections = ['https://youtube.com/watch?v=one', 'https://youtube.com/watch?v=two']
    for row, principal, url in zip((first, second), (ANA, BETO), selections, strict=True):
        pipeline.retry(row['id'], principal, selection=RetrySelection(index=0, youtube_url=url), schedule=False)
    seen = []
    async def chosen(req):
        seen.append(req.youtube_url)
        resolved = await original(req)
        return ResolvedVideo(req.youtube_url, resolved.reason, decision=resolved.decision)
    pipeline.engine._resolve_source_url = chosen
    async def retry_both():
        await asyncio.gather(pipeline.run(first['id']), pipeline.run(second['id']))
    asyncio.run(retry_both())
    assert sorted(seen) == sorted(selections)
    assert len(pipeline.engine.calls) == 2
    views = [pipeline.view(row['id'], principal) for row, principal in ((first, ANA), (second, BETO))]
    assert all(view['state'] == 'completo' for view in views)
    assert views[0]['stages']['fetch'] != views[1]['stages']['fetch']


def test_album_acquisition_publishes_only_cover_sidecar(pipeline):
    async def finish(path, *args):
        cover = path.parent / 'cover' / 'cover.jpg'
        cover.parent.mkdir()
        cover.write_bytes(b'album artwork')

    pipeline.engine._finish_staged_file = finish
    request = submit(pipeline, body(2))
    asyncio.run(pipeline.run(request['id']))

    songs = list(pipeline.root.rglob('*.mp3'))
    assert len(songs) == 2
    assert len({song.parent for song in songs}) == 1
    album = songs[0].parent
    assert (album / 'cover.jpg').read_bytes() == b'album artwork'
    assert not (album / 'cover').exists()
    assert list(pipeline.root.rglob('cover')) == []
