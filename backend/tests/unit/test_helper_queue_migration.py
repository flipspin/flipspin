"""Both old files migrate once; their rows become the ledger's own items."""
import logging
import shutil
from pathlib import Path
from unittest.mock import Mock

from app.dependencies import DependencyContainer
from app.infra.jobs import Jobs
from app.infra.jobs.queue import Queue
from app.infra.jobs_runtime import boot
from app.infra.progress import ProgressTracker
from app.domains.lyrics.jobs import AgentQueue
from app.domains.stems.jobs import StemsQueue
from app.domains.stems.repositories import StemsRepository

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures/helper_queue'
LOG = logging.getLogger(__name__)


def legacy_files(config, tmp_path):
    config.lyrics_file = tmp_path / 'lyrics.json'
    config.jobs_file = tmp_path / 'jobs.sqlite'
    for name in ('lyrics-queue.json', 'stems-queue.json'):
        shutil.copyfile(FIXTURES / name, tmp_path / name)


def test_both_legacy_files_migrate_once_and_keep_receipts(config, tmp_path):
    legacy_files(config, tmp_path)
    ledger = Jobs(config.jobs_file, now=lambda: 1000)
    failures = []
    def lyrics():
        return AgentQueue(path=tmp_path / 'lyrics-queue.json', progress_tracker=ProgressTracker(ledger),
                          logger=LOG, on_result=Mock(), on_failure=lambda r, e: failures.append((r.id, e)), now=lambda: 1000)
    first = lyrics()
    stems = StemsQueue(StemsRepository(config, LOG), LOG, ledger=ledger, worker=first.worker, now=lambda: 1000)
    assert first.status()['queued'] == 2
    assert len(stems.snapshot()['jobs']) == 2
    assert first.queue is stems.queue
    assert failures == [('q-dead', 'el equipo dejó de responder 3 veces')]
    rows = first.queue.rows(('align', 'transcribe', 'stems'))
    assert all(row['lease'] is None for row in rows)
    split = stems.get('A', 'Split.mp3')
    assert split.status == 'queued' and split.attempts == 2
    assert stems.get('A', 'Failed.mp3').error == 'no result'
    assert first.result_response('finished-lyrics', 'q-finished', 'helper') == {'accepted': True}
    assert stems.result_response('finished-stems', 'helper') == {'accepted': True, 'status': 'ready'}
    for name in ('lyrics', 'stems'):
        assert not (tmp_path / f'{name}-queue.json').exists()
        assert (tmp_path / f'{name}-queue.json.migrated').read_bytes() == (FIXTURES / f'{name}-queue.json').read_bytes()
    version, count = ledger.version, ledger.db.execute('SELECT count(*) FROM items').fetchone()[0]
    # Crash after commit but before rename: an old file reappearing must never
    # restore a lease or overwrite a subsequent result/cancel.
    shutil.copyfile(FIXTURES / 'lyrics-queue.json', tmp_path / 'lyrics-queue.json')
    again = lyrics()
    assert again.status()['queued'] == 2
    assert ledger.db.execute('SELECT count(*) FROM items').fetchone()[0] == count
    assert ledger.version == version
    assert len(failures) == 1
    ledger.close()


def test_startup_imports_before_replaying_queued_jobs(config, tmp_path, monkeypatch):
    legacy_files(config, tmp_path)
    config.lyrics_engine_mode = 'agent'
    for file in ('One.mp3', 'Two.mp3', 'Dead.mp3'):
        path = config.base_music_dir / 'A' / file
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b'audio')
    container = DependencyContainer(config)
    monkeypatch.setattr('app.infra.jobs_runtime.dispatch', Mock(side_effect=AssertionError('duplicate dispatch')))
    boot(container)
    # Legacy rows without an attributable starter migrate, but cannot resume.
    assert container.get_lyrics_service().agent_queue.status()['queued'] == 0
    assert container.get_stems_service().queue.get('A', 'Split.mp3') is None
    jobs = container.get_jobs().list()
    assert len(jobs) == 4
    assert {job['state'] for job in jobs} == {'interrupted', 'failed'}
    container.get_jobs().close()


def test_existing_ledger_without_queue_columns_is_upgraded(tmp_path):
    import sqlite3
    path = tmp_path / 'jobs.sqlite'
    old = sqlite3.connect(path)
    old.executescript('''CREATE TABLE items (job_id TEXT NOT NULL, idx INTEGER NOT NULL, attempt INTEGER NOT NULL,
        item TEXT NOT NULL, rel_path TEXT, state TEXT NOT NULL, reason TEXT, detail TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(job_id,idx,attempt));''')
    old.close()
    ledger = Jobs(path)
    queue = Queue(ledger)
    assert queue.rows(('stems',)) == []
    assert 'lease_until' in {r[1] for r in ledger.db.execute('PRAGMA table_info(items)')}
    ledger.close()


def test_partial_import_recovery_does_not_replay_finished_work(config, tmp_path, monkeypatch):
    legacy_files(config, tmp_path)
    ledger = Jobs(config.jobs_file, now=lambda: 1000)
    first = AgentQueue(path=tmp_path / 'lyrics-queue.json', progress_tracker=ProgressTracker(ledger),
                       logger=LOG, on_result=Mock(), on_failure=Mock(), now=lambda: 1000)
    # Fail after importing the items, before the marker can be committed.
    with monkeypatch.context() as patch:
        patch.setattr(first.queue, 'receipt', Mock(side_effect=OSError('disk full')))
        assert first.status()['queued'] == 2
    assert first.degraded
    got = first.claim({'name': 'Mac', 'version': '0.10.0'})
    assert got['jobs'][0]['id'] == 'q-one'
    assert first.result(got['lease'], 'q-one', ok=True, lrc='saved')['accepted']
    assert ledger.db.execute('SELECT attempts FROM items WHERE queue_id=?', ('q-one',)).fetchone()[0] == 2
    assert (tmp_path / 'lyrics-queue.json').exists()
    second = AgentQueue(path=first.path, progress_tracker=ProgressTracker(ledger), logger=LOG,
                        on_result=Mock(), on_failure=Mock(), now=lambda: 1000)
    assert second.status()['queued'] == 1
    assert [i['state'] for i in ledger.items('lyrics-batch')] == ['done', 'queued']
    assert ledger.db.execute('SELECT attempts FROM items WHERE queue_id=?', ('q-one',)).fetchone()[0] == 2
    assert not first.path.exists()
    ledger.close()
