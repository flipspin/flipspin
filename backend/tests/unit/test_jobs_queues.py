"""Helper leases and outcomes share the same durable item record."""
import json
import logging

import pytest

from app.infra.jobs import Jobs
from app.infra.progress import ProgressTracker, progress_principal
from app.domains.accounts.identity import Principal
from app.domains.lyrics.jobs import AgentQueue
from app.domains.stems.jobs import StemsQueue
from app.domains.stems.repositories import StemsRepository

MAC = {'name': 'Mac', 'platform': 'darwin-arm64', 'version': '0.10.0'}
LOG = logging.getLogger(__name__)


def test_resumed_migration_outcome_advances_queue_version(tmp_path):
    from app.infra.jobs.kinds import JobKind
    from app.infra.jobs.queue import Queue

    ledger = Jobs(tmp_path / 'jobs.sqlite')
    try:
        queue = Queue(ledger)
        queue.kinds.register(JobKind('align', (), lambda row: None, 'lyrics-helper'))
        # Model a crash after importing the item, before finalizing its job.
        row = queue.enqueue('align', 'song', {'id': 'legacy'}, initial={'status': 'cancelled'})
        path = tmp_path / 'legacy-queue.json'
        path.write_text(json.dumps({'jobs': [row]}))
        assert queue.rows(('align',))
        version = ledger.version
        queue.migrate(path, 'jobs', lambda data: ('align', 'song', data, {}), default_kind='align')
        assert queue.rows(('align',)) == []
        assert ledger.version > version
    finally:
        ledger.close()


@pytest.fixture(autouse=True)
def starter():
    """Queue recovery tests represent work started by an identified request."""
    token = progress_principal.set(Principal('member', 'Member'))
    yield
    progress_principal.reset(token)


def lyrics(tmp_path, ledger, *, fail=False):
    def result(*args):
        if fail:
            raise RuntimeError('save refused')
    return AgentQueue(path=tmp_path / 'lyrics-queue.json', progress_tracker=ProgressTracker(ledger),
                      logger=LOG, on_result=result, on_failure=lambda *args: None)


def test_helper_row_first_claim_failure_retry_and_late_result(tmp_path):
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    queue = lyrics(tmp_path, ledger, fail=True)
    specs = [{'item':'One', 'relPath':'A/one.mp3'}, {'item':'Two', 'relPath':'A/two.mp3'}]
    token = progress_principal.set(Principal('member', 'Member'))
    job = queue.enqueue(specs)
    progress_principal.reset(token)
    assert queue.enqueue(specs) == job
    saved = queue.queue.rows(queue.kinds)
    assert all(row['jobId'] == job for row in saved)
    assert ledger.get(job)['state'] == 'queued'
    claimed = queue.claim(MAC)
    lease, row = claimed['lease'], claimed['jobs'][0]['id']
    assert ledger.get(job)['state'] == 'running'
    assert ledger.items(job)[0]['state'] == 'running'
    queue.result(lease, row, ok=True, lrc='[00:01.00] hi')
    assert ledger.items(job)[0]['state'] == 'failed'
    claimed = queue.claim(MAC)
    queue.result(claimed['lease'], claimed['jobs'][0]['id'], ok=False, error='no singing')
    assert ledger.get(job)['state'] == 'failed'
    assert ledger.retryable(job)
    assert ledger.retry(job, 1) == (2, True)
    queue.enqueue(specs, progress_id=job)
    claimed = queue.claim(MAC)
    ledger.cancel(job, 2)
    assert queue.heartbeat(claimed['lease'], claimed['jobs'][0]['id'])['stop']
    assert not queue.result(claimed['lease'], claimed['jobs'][0]['id'], ok=True, lrc='late')['accepted']
    assert ledger.get(job)['state'] == 'cancelled'
    assert ledger.get(job)['starter_user_id'] == 'member'
    ledger.close()


def test_queued_and_running_helpers_resume_once_without_their_old_leases(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    ledger = Jobs(path)
    first = lyrics(tmp_path, ledger)
    running = first.enqueue([{'item':'Running', 'relPath':'A/r.mp3'}])
    queued = first.enqueue([{'item':'Queued', 'relPath':'A/q.mp3'}])
    first.claim(MAC)
    ledger.close()  # lost process: no queue or shutdown hook called
    new = Jobs(path)
    new.boot()
    recovered = lyrics(tmp_path, new)
    assert recovered.status()['queued'] == 2
    assert new.get(running)['state'] == 'running'
    got = recovered.claim(MAC)
    assert [r['item'] for r in got['jobs']] == ['Running']
    recovered.result(got['lease'], got['jobs'][0]['id'], ok=True, lrc='[00:01.00] hi')
    got = recovered.claim(MAC)
    assert [r['item'] for r in got['jobs']] == ['Queued']
    recovered.result(got['lease'], got['jobs'][0]['id'], ok=True, lrc='[00:01.00] hi')
    assert new.get(queued)['state'] == 'succeeded'
    assert recovered.claim(MAC)['jobs'] == []
    new.close()


def test_completed_helper_items_survive_partial_batch_reboot(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    ledger = Jobs(path)
    queue = lyrics(tmp_path, ledger)
    job = queue.enqueue([{'item':name, 'relPath':f'A/{name}.mp3'} for name in ('One','Two')])
    got = queue.claim(MAC)
    queue.result(got['lease'], got['jobs'][0]['id'], ok=True, lrc='[00:01.00] hi')
    ledger.close()
    second = Jobs(path)
    second.boot()
    recovered = lyrics(tmp_path, second)
    assert second.get(job)['state'] == 'running'
    assert [i['state'] for i in second.items(job)] == ['done', 'queued']
    got = recovered.claim(MAC)
    assert [r['item'] for r in got['jobs']] == ['Two']
    recovered.result(got['lease'], got['jobs'][0]['id'], ok=True, lrc='[00:01.00] hi')
    assert second.get(job)['state'] == 'succeeded'
    assert second.get(job)['succeeded'] == 2
    state = recovered.progress_tracker.get_progress(job)
    assert state.succeeded == state.completed == state.total == 2
    second.close()


def test_stems_claim_failure_retry_cancel_and_restart(config):
    path = config.jobs_file
    ledger = Jobs(path)
    repository = StemsRepository(config, LOG)
    queue = StemsQueue(repository, LOG, ledger=ledger)
    job = queue.request('A', 'Title.mp3')
    assert ledger.get(job.id)['kind'] == 'stems'
    assert ledger.get(job.id)['label'] == 'Title'
    assert queue.queue.rows(queue.kinds)[0]['jobId'] == job.id
    assert queue.request('A','Title.mp3').id == job.id
    got = queue.claim(MAC)
    queue.fail(got.lease, 'no result', final=True)
    assert ledger.get(job.id)['state'] == 'failed'
    assert ledger.retryable(job.id)
    ledger.retry(job.id, 1)
    queue.request('A', 'Title.mp3', job_id=job.id)
    got = queue.claim(MAC)
    ledger.cancel(job.id, 2)
    assert queue.heartbeat(got.lease)['stop']
    assert queue.leased(got.lease) is None
    assert not queue.complete(got.lease)
    other = queue.request('A', 'Other.mp3')
    ledger.close()
    new = Jobs(path)
    new.boot()
    recovered = StemsQueue(repository, LOG, ledger=new)
    got = recovered.claim(MAC)
    assert got.id == other.id
    assert recovered.complete(got.lease)
    assert new.get(other.id)['state'] == 'succeeded'
    new.close()


def test_ledger_write_failure_enqueues_nothing(tmp_path, monkeypatch):
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    queue = lyrics(tmp_path, ledger)
    def refuse(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(ledger, 'start', refuse)
    with pytest.raises(OSError):
        queue.enqueue([{'item':'One', 'relPath':'A/one.mp3'}])
    assert queue._rows == {}
    assert not queue.path.exists()
    ledger.close()


def test_stems_can_be_requested_again_after_ledger_cancel(config):
    ledger = Jobs(config.jobs_file)
    queue = StemsQueue(StemsRepository(config, LOG), LOG, ledger=ledger)
    first = queue.request('A', 'Title.mp3')
    lease = queue.claim(MAC).lease
    ledger.cancel(first.job_id, 1)
    assert queue.heartbeat(lease)['stop']
    second = queue.request('A', 'Title.mp3')
    assert second.job_id != first.job_id
    assert queue.request('A', 'Title.mp3').job_id == second.job_id
    claimed = queue.claim(MAC)
    assert claimed.job_id == second.job_id
    assert not queue.complete(lease)
    assert queue.complete(claimed.lease)
    ledger.close()


def test_lanes_precede_kind_and_round_robin_survives_connections(tmp_path):
    from app.infra.jobs.kinds import JobKind
    from app.infra.jobs.queue import Queue

    path = tmp_path / 'jobs.sqlite'
    ledger = Jobs(path)
    q = Queue(ledger, now=lambda: 1000)
    for kind in ('align', 'stems', 'analysis'):
        q.kinds.register(JobKind(kind, (), lambda row: None, 'analysis' if kind == 'analysis' else 'stems'))
    for kind in ('align', 'stems', 'analysis'):
        for index in range(3):
            q.enqueue(kind, f'{kind}-{index}', {'lane': 'library'})
    q.enqueue('analysis', 'new', {'lane': 'new'})
    q.enqueue('stems', 'waiting', {'lane': 'now'})
    q.enqueue('align', 'new', {'lane': 'new'})
    expected = [('stems', 'now'), ('align', 'new'), ('analysis', 'new'),
                ('align', 'library'), ('analysis', 'library'), ('stems', 'library'),
                ('align', 'library'), ('analysis', 'library'), ('stems', 'library')]
    for index, (kind, tier) in enumerate(expected):
        if index == 4:
            ledger.close()
            ledger = Jobs(path)
            q = Queue(ledger, now=lambda: 1000)
            for name in ('align', 'stems', 'analysis'):
                q.kinds.register(JobKind(name, (), lambda row: None, 'analysis' if name == 'analysis' else 'stems'))
        row = q.claim(('align', 'stems', 'analysis'), 'worker')
        assert (row['kind'], row['lane']) == (kind, tier)
        assert q.complete(row['id'], row['lease'])
    ledger.close()


def test_ineligible_kind_does_not_block_and_batches_cannot_cross_lanes(tmp_path):
    from app.infra.jobs.kinds import JobKind
    from app.infra.jobs.queue import Queue

    ledger = Jobs(tmp_path / 'jobs.sqlite')
    q = Queue(ledger)
    q.kinds.register(JobKind('align', ('gpu',), lambda row: None, 'lyrics-helper'))
    q.kinds.register(JobKind('analysis', (), lambda row: None, 'analysis'))
    q.enqueue('align', 'waiting', {'lane': 'now'})
    q.enqueue('analysis', 'new', {'lane': 'new'})
    q.enqueue('analysis', 'library', {'lane': 'library'})
    rows = q.claim_batch(('align', 'analysis'), 'cpu', capabilities=[])
    assert [r['lane'] for r in rows] == ['new']
    ledger.close()


def test_legacy_stems_claim_obeys_person_waiting_and_fair_turns(config, tmp_path):
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    q = lyrics(tmp_path, ledger)
    stems = StemsQueue(StemsRepository(config, LOG), LOG, ledger=ledger, worker=q.worker)
    q.enqueue([{'relPath': 'A/library.mp3', 'lane': 'library'}])
    first = stems.request('A', 'waiting.mp3')
    assert q.claim(MAC)['jobs'] == []
    assert stems.claim(MAC).id == first.id
    assert stems.complete(first.lease)
    # Same lane: the next kind takes its turn even through a legacy endpoint.
    q.enqueue([{'relPath': 'A/now.mp3'}])
    stems.request('A', 'another.mp3')
    assert stems.claim(MAC) is None
    got = q.claim(MAC)
    assert got['jobs'][0]['relPath'] == 'A/now.mp3'
    assert q.result(got['lease'], got['jobs'][0]['id'], ok=True, lrc='words')['accepted']
    assert stems.claim(MAC).file == 'another.mp3'
    ledger.close()


def test_resource_deferrals_do_not_exhaust_the_failure_budget(tmp_path):
    from app.infra.jobs.kinds import JobKind
    from app.infra.jobs.queue import Queue
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    q = Queue(ledger)
    q.kinds.register(JobKind('stems', (), lambda row: None, 'stems'))
    row = q.enqueue('stems', 'song', {'lane': 'library'})
    for _ in range(5):
        claimed = q.claim(('stems',), 'worker')
        assert claimed['attempts'] == 1
        q.defer_holder('worker')
        assert not q.complete(row['id'], claimed['lease'])
    assert q.get(row['id'])['status'] == 'queued'
    ledger.close()


def test_waiting_person_promotes_a_deduplicated_library_lyric(tmp_path):
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    q = lyrics(tmp_path, ledger)
    job = q.enqueue([{'relPath': 'A/song.mp3', 'lane': 'library'}])
    assert q.enqueue([{'relPath': 'A/song.mp3'}]) == job
    rows = q.queue.rows(q.kinds)
    assert len(rows) == 1 and rows[0]['lane'] == 'now'
    q.enqueue([{'relPath': 'A/song.mp3', 'lane': 'library'}])
    assert q.queue.rows(q.kinds)[0]['lane'] == 'now'
    ledger.close()


def test_old_analysis_backlog_defaults_to_library_and_legacy_lyrics_are_tiered(tmp_path):
    from app.infra.jobs.kinds import JobKind
    from app.infra.jobs.queue import lane
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    q = lyrics(tmp_path, ledger)
    job = q.enqueue([{'relPath': 'A/one.mp3'}, {'relPath': 'A/two.mp3'}])
    for data in q.queue.rows(q.kinds):
        data.pop('lane')
        q.queue.save_payload(data)
    q._sync()
    assert all(row.lane == 'library' for row in q._rows.values())
    assert all(data['lane'] == 'library' for data in q.queue.rows(q.kinds))
    q.queue.kinds.register(JobKind('analysis', (), lambda row: None, 'analysis'))
    old = q.queue.enqueue('analysis', 'old', {'relPath': 'A/old.mp3'})
    assert lane(old) == 'library'
    assert ledger.get(job)['total'] == 2
    ledger.close()
