"""Live legacy views pinned from the JSON queues at ed1a8e6.

The fixture includes the later additive selection (lyrics choice) and labels
(helper capabilities) fields. Older fields remain pinned byte for byte.

IDs are opaque; only their random values are normalized. Everything else,
including nulls, aliases, phases, error words and progress, is compared as JSON.
"""
import json
import logging
from pathlib import Path

from app.infra.progress import ProgressTracker
from app.domains.lyrics.jobs import AgentQueue
from app.domains.stems.jobs import StemsQueue
from app.domains.stems.repositories import StemsRepository

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/helper_queue/legacy-views.json'
AGENT = {'id': 'helper', 'name': 'Mac', 'version': '0.8.0'}


def normalized(value, key=''):
    if isinstance(value, dict):
        return {k: normalized(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalized(v, key) for v in value]
    if key in ('id', 'progress_id', 'jobId', 'progressId', 'lease') and value is not None:
        return '<opaque>'
    return value


def scenario(config, tmp_path, lyrics_class=AgentQueue, stems_class=StemsQueue, repository_class=StemsRepository):
    clock = [1000.0]
    logger = logging.getLogger(__name__)
    config.lyrics_file = tmp_path / 'lyrics.json'
    lyrics = lyrics_class(path=tmp_path / 'lyrics-queue.json', progress_tracker=ProgressTracker(), logger=logger,
                          on_result=lambda *args: None, on_failure=lambda *args: None, now=lambda: clock[0])
    stems = stems_class(repository_class(config, logger), logger, worker=lyrics.worker, now=lambda: clock[0])
    views = {}
    def record(name):
        views[name] = normalized({'lyrics': lyrics.status(), 'stems': stems.snapshot()})
    lyrics.enqueue([{'relPath': 'Album/One.mp3', 'item': 'One', 'text': 'words'},
                    {'relPath': 'Album/Two.mp3', 'item': 'Two'}])
    stems.request('Album', 'Split.mp3')
    record('queued')
    got = lyrics.claim(AGENT)
    clock[0] += 10
    lyrics.heartbeat(got['lease'], got['jobs'][0]['id'], 'alineando', 40)
    record('lyrics-working')
    lyrics.result(got['lease'], got['jobs'][0]['id'], ok=False, error='network', final=False)
    record('lyrics-accident')
    for _ in range(2):
        got = lyrics.claim(AGENT)
        lyrics.result(got['lease'], got['jobs'][0]['id'], ok=True, lrc='[00:01.00] words')
    got = stems.claim(AGENT)
    stems.heartbeat(got.lease, 'separando', 50.0)
    record('stems-working')
    stems.fail(got.lease, 'bad audio', final=True)
    record('stems-final-failure')
    if hasattr(lyrics, 'queue'):
        lyrics.ledger.close()
        stems.ledger.close()
    return views


def test_legacy_live_views_are_byte_compatible(config, tmp_path, monkeypatch):
    monkeypatch.setattr("app.domains.helpers.mac_worker.MIN_WORKER_VERSION", "0.8.0")
    expected = json.loads(FIXTURE.read_text())
    actual = scenario(config, tmp_path)
    # New scheduling and provenance fields are additive. Continue pinning every
    # previously shipped key and value, including nulls and array cardinality.
    def shipped(value, baseline):
        if isinstance(baseline, dict):
            return {key: shipped(value[key], old) for key, old in baseline.items()}
        if isinstance(baseline, list):
            assert len(value) == len(baseline)
            return [shipped(new, old) for new, old in zip(value, baseline, strict=True)]
        return value
    legacy = shipped(actual, expected)
    assert legacy == expected
    assert json.dumps(legacy, sort_keys=True, ensure_ascii=False) == json.dumps(expected, sort_keys=True, ensure_ascii=False)
