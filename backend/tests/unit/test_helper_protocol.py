"""Executable helper protocol shared with future helper clients."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from app.infra.jobs import Jobs
from app.infra.jobs.kinds import JobKind
from app.infra.jobs.queue import Queue, LEASE_STALE_S, MAX_ATTEMPTS

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / 'contracts/helper-protocol.json').read_text())


def register(queue, applied):
    for kind in ('align', 'transcribe', 'stems'):
        queue.kinds.register(JobKind(kind, (f'jobs:{kind}',), lambda data: applied.append(data['id']),
                                     'stems' if kind == 'stems' else 'lyrics-helper', order=int(kind == 'stems')))


@pytest.mark.parametrize('case', CONTRACT['cases'], ids=lambda case: case['name'])
def test_helper_protocol(case, tmp_path):
    assert CONTRACT['leaseSeconds'] == LEASE_STALE_S
    assert CONTRACT['maxAttempts'] == MAX_ATTEMPTS
    clock, applied, refs = [1000.0], [], {}
    ledger = Jobs(tmp_path / 'jobs.sqlite', now=lambda: clock[0])
    queue = Queue(ledger, now=lambda: clock[0])
    register(queue, applied)
    try:
        for step in case['steps']:
            args, expected = step['input'], step['expected']
            op = args['op']
            if op == 'enqueue':
                row = queue.enqueue(args['kind'], args['key'], {'item': args['key']})
                if 'sameAs' in args:
                    actual = {'sameJob': row['id'] == refs[args['sameAs']], 'records': len(ledger.list())}
                else:
                    refs[args['as']] = row['id']
                    actual = row
            elif op == 'claim':
                actual = queue.claim(('align', 'transcribe', 'stems'), args['holder'],
                                     args.get('capabilities', ['jobs:align', 'jobs:transcribe', 'jobs:stems']))
                if actual is not None:
                    refs[args['as']] = actual['lease']
            elif op == 'advance':
                clock[0] += args['seconds']
                actual = None
            elif op == 'heartbeat':
                actual = queue.heartbeat(refs[args['job']], refs[args['lease']], args.get('phase'), args.get('progress'))
            elif op == 'complete':
                actual = queue.complete(refs[args['job']], refs[args['lease']])
            elif op == 'fail':
                actual = queue.fail(refs[args['job']], refs[args['lease']], args['reason'], final=args['final'])
            elif op == 'cancel':
                actual = queue.cancel(refs[args['job']])
            elif op == 'inspect':
                actual = {**queue.get(refs[args['job']]), 'applied': len(applied)}
            else:
                raise AssertionError(op)
            if isinstance(actual, dict) and 'lease_until' in actual:
                actual['leaseSeconds'] = actual['lease_until'] - clock[0] if actual['lease_until'] else None
            if isinstance(expected, dict):
                assert {key: actual[key] for key in expected} == expected, args
            else:
                assert actual == expected, args
    finally:
        ledger.close()


def test_independent_connections_claim_and_enqueue_atomically(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    ledgers = [Jobs(path) for _ in range(2)]
    queues = [Queue(ledger) for ledger in ledgers]
    for queue in queues:
        register(queue, [])
    barrier = Barrier(2)
    def enqueue(index):
        barrier.wait()
        return queues[index].enqueue('stems', 'same', {'item': 'Same'})
    try:
        with ThreadPoolExecutor(2) as pool:
            rows = list(pool.map(enqueue, (0, 1)))
        assert rows[0]['id'] == rows[1]['id']
        assert len(ledgers[0].list()) == 1
        for n in range(24):
            queues[0].enqueue('stems', str(n), {'item': str(n)})
        def claim(index):
            barrier.wait()
            return queues[index].claim(('stems',), f'holder-{index}')
        with ThreadPoolExecutor(2) as pool:
            rows = list(pool.map(claim, (0, 1)))
        assert rows[0]['id'] != rows[1]['id']
        assert ledgers[0].db.execute("SELECT count(*) FROM items WHERE state='running'").fetchone()[0] == 2
        # A holder cannot claim a second kind while it owns a lease.
        assert queues[1].claim(('stems',), 'holder-0') is None
        assert ledgers[0].db.execute('PRAGMA synchronous').fetchone()[0] == 2
        assert ledgers[0].db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    finally:
        for ledger in ledgers:
            ledger.close()
