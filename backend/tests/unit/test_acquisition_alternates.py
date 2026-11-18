"""A chosen candidate the source reports gone gives way to the next acceptable one, in the same attempt."""
import asyncio

import pytest

from app.domains.downloads.core import ResolvedVideo
from app.exceptions import FailureKind, SourceFailure
from tests.unit import test_acquisition as helpers

pipeline = helpers.pipeline
submit = helpers.submit

FIRST, SECOND, THIRD = (f'https://youtube.com/watch?v={name}' for name in ('gone', 'next', 'last'))


def failure(kind):
    error = SourceFailure('source said no')
    error.kind = kind
    return error


def with_candidates(pipeline, outcomes, *, alternates=(SECOND, THIRD)):
    """Each fetch of a URL in ``outcomes`` raises that kind; any other URL succeeds."""
    fetched, recorded = [], []

    async def match(request, *, exclude=()):
        return ResolvedVideo(FIRST, 'close enough', decision='REVIEW', alternates=alternates)

    async def fetch(url, destination, filename, percent_cb=None):
        fetched.append(url)
        assert not any(destination.iterdir()), 'staging is cleaned between candidates'
        if url in outcomes:
            (destination / 'partial.part').write_bytes(b'half')
            raise failure(outcomes[url])
        path = destination / f'{filename}.mp3'
        path.write_bytes(b'complete audio')
        return path

    original = pipeline.health.failure
    pipeline.health.failure = lambda provider, error: (recorded.append(error.kind), original(provider, error))
    pipeline.engine._resolve_source_url = match
    pipeline.engine._download_audio_file = fetch
    return fetched, recorded


def item_detail(pipeline, row):
    """The song's public detail across its stage entries (the view lists one per stage)."""
    view = pipeline.view(row['id'], helpers.ANA)
    merged = {}
    for item in view['items']:
        merged.update(item['detail'])
    return view, merged


def test_a_gone_candidate_falls_through_to_the_next_without_pausing_the_source(pipeline):
    fetched, recorded = with_candidates(pipeline, {FIRST: FailureKind.NOT_FOUND})
    row = submit(pipeline)
    results = asyncio.run(pipeline.run(row['id']))
    assert results[0].success
    assert fetched == [FIRST, SECOND]
    assert recorded == []
    assert pipeline.health.status(pipeline.source_id)['state'] == 'ok'
    view, detail = item_detail(pipeline, row)
    assert view['state'] == 'completo'
    assert detail['skippedCandidates'] == 1


def test_when_every_candidate_is_gone_the_song_is_not_found_once_and_never_retried_later(pipeline):
    fetched, recorded = with_candidates(pipeline, {FIRST: FailureKind.NOT_FOUND, SECOND: FailureKind.NOT_FOUND, THIRD: FailureKind.NOT_FOUND})
    row = submit(pipeline)
    assert not asyncio.run(pipeline.run(row['id']))[0].success
    assert fetched == [FIRST, SECOND, THIRD]
    assert recorded == [FailureKind.NOT_FOUND]
    assert pipeline.health.status(pipeline.source_id)['state'] == 'ok'
    _, detail = item_detail(pipeline, row)
    assert detail['kind'] == FailureKind.NOT_FOUND
    assert detail['error'] == 'No matching audio was found.'


@pytest.mark.parametrize('kind', [FailureKind.BROKEN, FailureKind.BLOCKED, FailureKind.RATE_LIMITED,
                                  FailureKind.AUTH_REQUIRED, FailureKind.NETWORK])
def test_other_failures_keep_their_policy_and_do_not_try_another_candidate(pipeline, kind):
    fetched, recorded = with_candidates(pipeline, {FIRST: kind})
    row = submit(pipeline)
    asyncio.run(pipeline.run(row['id']))
    assert fetched[0] == FIRST and SECOND not in fetched
    assert kind in recorded


def test_a_choice_without_alternates_does_not_fall_through(pipeline):
    fetched, recorded = with_candidates(pipeline, {FIRST: FailureKind.NOT_FOUND}, alternates=())
    row = submit(pipeline)
    assert not asyncio.run(pipeline.run(row['id']))[0].success
    assert fetched == [FIRST]
    assert recorded == [FailureKind.NOT_FOUND]


def test_alternates_are_capped(pipeline):
    many = tuple(f'https://youtube.com/watch?v=alt{i}' for i in range(6))
    fetched, _ = with_candidates(pipeline, {url: FailureKind.NOT_FOUND for url in (FIRST, *many)}, alternates=many)
    row = submit(pipeline)
    assert not asyncio.run(pipeline.run(row['id']))[0].success
    assert fetched == [FIRST, *many[:3]]


def test_a_cancel_during_an_alternate_stops_the_fall_through(pipeline, monkeypatch):
    fetched, _ = with_candidates(pipeline, {FIRST: FailureKind.NOT_FOUND, SECOND: FailureKind.NOT_FOUND})
    row = submit(pipeline)
    original = pipeline.engine._download_audio_file

    async def cancel_on_second(url, destination, filename, percent_cb=None):
        if url == SECOND:
            pipeline.cancel(row['id'], helpers.ANA)
        return await original(url, destination, filename, percent_cb)

    pipeline.engine._download_audio_file = cancel_on_second
    asyncio.run(pipeline.run(row['id']))
    assert THIRD not in fetched


def result(title, vid, duration=None):
    return {"title": title, "url": f"https://www.youtube.com/watch?v={vid}", "duration": duration, "artist": None, "id": vid}


def test_alternates_follow_the_same_ranking_and_never_offer_a_vetoed_or_chosen_candidate():
    from app.domains.acquisition.matching import ranked_alternates, select_video
    from app.domains.metadata.matching import WantedTrack
    wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=248)
    results = [
        result("Daft Punk - Get Lucky (Official Audio)", "a", 248),
        result("Daft Punk - Get Lucky (Live at the Grammys)", "live", 250),
        result("Daft Punk - Get Lucky", "b", 249),
        result("Daft Punk - Get Lucky (Lyrics)", "c", 247),
        result("Daft Punk - Get Lucky (Nightcore Remix)", "remix", 200),
        result("Daft Punk - Get Lucky (Audio)", "d", 248),
        result("Daft Punk - Get Lucky (HQ)", "e", 248),
    ]
    choice = select_video(wanted, results)
    alternates = ranked_alternates(wanted, results, chosen=choice.url)
    assert choice.accepted and choice.url not in alternates
    assert len(alternates) == 3 and len(set(alternates)) == 3
    assert not any(vid in url for url in alternates for vid in ("v=live", "v=remix"))
    later = ranked_alternates(wanted, results, chosen=choice.url, exclude=alternates[:1])
    assert alternates[0] not in later


def stage_item(pipeline, row, stage):
    return next(item for item in pipeline.view(row['id'], helpers.ANA)['items'] if item['stage'] == stage)


def test_every_candidate_gone_fails_the_fetch_not_the_match_and_says_how_many_were_tried(pipeline):
    with_candidates(pipeline, {FIRST: FailureKind.NOT_FOUND, SECOND: FailureKind.NOT_FOUND, THIRD: FailureKind.NOT_FOUND})
    row = submit(pipeline)
    asyncio.run(pipeline.run(row['id']))
    match, fetch = stage_item(pipeline, row, 'match'), stage_item(pipeline, row, 'fetch')
    assert match['state'] == 'done'
    assert fetch['state'] == 'failed' and fetch['reason'] == 'no-encontrada'
    assert fetch['detail']['failedStage'] == 'fetch'
    assert fetch['detail']['candidatesTried'] == 3


def test_nothing_matching_fails_the_match_with_no_candidate_count(pipeline):
    async def nothing(request, *, exclude=()):
        return ResolvedVideo(None, 'no source results', 'no-results')
    pipeline.engine._resolve_source_url = nothing
    row = submit(pipeline)
    asyncio.run(pipeline.run(row['id']))
    match = stage_item(pipeline, row, 'match')
    assert match['state'] == 'failed' and match['reason'] == 'no-encontrada'
    assert 'candidatesTried' not in match['detail']


def test_the_failed_item_detail_on_the_wire(pipeline):
    from tests.integration.test_wire_snapshots import assert_matches_snapshot
    with_candidates(pipeline, {FIRST: FailureKind.NOT_FOUND, SECOND: FailureKind.NOT_FOUND, THIRD: FailureKind.NOT_FOUND})
    row = submit(pipeline)
    asyncio.run(pipeline.run(row['id']))
    detail = dict(stage_item(pipeline, row, 'fetch')['detail'])
    detail['failedAt'] = 0
    assert_matches_snapshot('acquisition-failed-item', detail)
