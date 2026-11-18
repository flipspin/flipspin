#!/usr/bin/env python3
"""Compare disk discovery on a disposable RAM-backed tree of tiny, valid WAVs.

Run once per backend checkout with a separate empty --state directory. The warm
case explicitly requests a change scan, rather than timing a cached getter.
Pass --prepare on the first run; --restore resets the one changed file before
another checkout is measured. Put --tree and --state on tmpfs (or a RAM disk).
"""
import argparse
import io
import json
import logging
import sys
import time
import wave
from pathlib import Path
from types import SimpleNamespace


def wav(payload=b'\0\0'):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(payload)
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', type=Path, default=Path(__file__).resolve().parent.parent / 'backend')
    parser.add_argument('--tree', required=True, type=Path)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--files', type=int, default=50_000)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--restore', action='store_true')
    parser.add_argument('--listing-polls', type=int, default=0, help='HTTP conditional polls on the incremental backend')
    args = parser.parse_args()
    if args.files < 100 or args.state.exists():
        parser.error('--files must be >=100 and --state must not already exist')
    args.state.mkdir(parents=True)
    data = wav()
    if args.prepare:
        if args.tree.exists():
            parser.error('--prepare requires a new tree')
        for index in range(args.files):
            path = args.tree / f'album-{index // 100:04d}' / f'{index % 100:03d}.wav'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    changed = args.tree / 'album-0000' / '000.wav'
    if args.restore:
        changed.write_bytes(data)
    actual = sum(1 for _ in args.tree.rglob('*.wav'))
    if actual != args.files:
        parser.error(f'expected {args.files} files, found {actual}')
    sys.path.insert(0, str(args.backend.resolve()))
    import app.domains.music.repositories as module
    from app.domains.music.repositories import MusicRepository
    logger = logging.getLogger('scan-benchmark')
    logger.addHandler(logging.NullHandler())
    logger.propagate = False
    config = SimpleNamespace(base_music_dir=args.tree.resolve(), analysis_db=args.state / 'analysis.sqlite')
    reader = module.MutagenFile
    reads = 0
    def read(*a, **kw):
        nonlocal reads
        reads += 1
        return reader(*a, **kw)
    module.MutagenFile = read
    repo = MusicRepository(config, logger)
    incremental = hasattr(repo, 'refresh')
    def scan():
        if incremental:
            return repo.refresh(reason='benchmark')
        repo.invalidate_scan()
        return repo.scan_albums()
    def measure(label):
        nonlocal reads
        reads = 0
        start = time.perf_counter()
        albums = scan()
        elapsed = time.perf_counter() - start
        count = sum(len(a.tracks) for a in albums)
        assert count == args.files, (label, count)
        result = {'seconds': round(elapsed, 4), 'tagReads': reads, 'tracks': count}
        print(label + ': ' + json.dumps(result), file=sys.stderr, flush=True)
        return result
    result = {'files': args.files, 'folders': (args.files + 99) // 100}
    result['cold'] = measure('cold')
    result['warmNoChange'] = measure('warm')
    changed.write_bytes(wav(b'\0\0\0\0'))
    result['oneFolderChanged'] = measure('changed')
    repo = MusicRepository(config, logger)
    result['restartNoChange'] = measure('restart')
    if incremental:
        assert result['cold']['tagReads'] == args.files
        assert result['warmNoChange']['tagReads'] == 0
        assert result['oneFolderChanged']['tagReads'] == 1
        assert result['restartNoChange']['tagReads'] == 0
    if args.listing_polls and incremental:
        from statistics import median

        from app.dependencies import get_library_scope, get_music_service
        from app.domains.music.routes import router
        from app.domains.music.scan_worker import ScanWorker
        from app.domains.music.services import MusicService
        from app.domains.user_library.scope import LibraryScope
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        # Hosted getter mode, without starting unrelated background jobs.
        repo.scans.worker = ScanWorker(repo)
        service = MusicService(repo, None, config, logger)
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_music_service] = lambda: service
        app.dependency_overrides[get_library_scope] = lambda: LibraryScope()
        with TestClient(app) as client:
            url = '/api/listar-albums-con-metadata?covers=false'
            etag = client.get(url).headers['etag']
            samples = []
            for _ in range(args.listing_polls):
                start = time.perf_counter()
                response = client.get(url, headers={'If-None-Match': etag})
                samples.append((time.perf_counter() - start) * 1000)
                assert response.status_code == 304 and not response.content
        result['conditionalListing'] = {'polls': args.listing_polls, 'medianMs': round(median(samples), 3)}
    print(json.dumps(result, indent=2), flush=True)


if __name__ == '__main__':
    main()
