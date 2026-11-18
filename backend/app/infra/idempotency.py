"""Shared 24-hour request receipts in jobs.sqlite (the acquisition and offline wire schema)."""
from __future__ import annotations

import inspect
import hashlib
import json
import time
from contextlib import contextmanager
from functools import wraps

from app.infra.request_paths import routing_path
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse


def canonical(body) -> str:
    return json.dumps(jsonable_encoder(body), sort_keys=True, separators=(',', ':'), ensure_ascii=False)


@contextmanager
def database(path):
    from app.infra.jobs.schema import JOBS
    from app.infra.migrations import open_store

    db = open_store(path, JOBS)
    try:
        with db:
            yield db
    finally:
        db.close()


class Receipts:
    def __init__(self, path):
        self.path = path

    def begin(self, key, account, route, body):
        digest = hashlib.sha256(canonical(body).encode()).hexdigest()
        with database(self.path) as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM idempotency_keys WHERE created_at < ?', (time.time() - 86400,))
            row = db.execute('SELECT body_hash,status,response FROM idempotency_keys WHERE key=? AND account_id=? AND route=?', (key, account, route)).fetchone()
            if row:
                if row[0] != digest:
                    raise HTTPException(422, 'Idempotency-Key already used with another body')
                if row[1] == 0:
                    raise HTTPException(409, 'Request in flight')
                return row[1], json.loads(row[2])
            db.execute('INSERT INTO idempotency_keys VALUES(?,?,?,?,?,?,?)', (key, account, route, digest, 0, '', time.time()))
        return None

    def finish(self, key, account, route, status, body):
        with database(self.path) as db:
            db.execute('UPDATE idempotency_keys SET status=?,response=? WHERE key=? AND account_id=? AND route=?', (status, canonical(body), key, account, route))

    def abandon(self, key, account, route):
        with database(self.path) as db:
            db.execute('DELETE FROM idempotency_keys WHERE key=? AND account_id=? AND route=? AND status=0', (key, account, route))


def idempotent(function):
    """Runs after FastAPI authentication/validation. Stores errors as well as success."""
    @wraps(function)
    def call(*args, **kwargs):
        request = kwargs.get('request')
        key = request.headers.get('idempotency-key') if request else None
        if not key:
            return function(*args, **kwargs)
        if len(key) > 200:
            raise HTTPException(422, 'Idempotency-Key too long')
        config = kwargs.get('config') or kwargs['playlist_service'].config
        receipts = Receipts(config.jobs_file)
        account = kwargs['principal'].user_id
        route = f'{request.method} {routing_path(request)}'
        body = {k: v for k, v in kwargs.items() if k in ('body', 'tracks', 'data', 'name')}
        prior = receipts.begin(key, account, route, body)
        if prior:
            return JSONResponse(prior[1], status_code=prior[0])
        try:
            result = function(*args, **kwargs)
        except HTTPException as error:
            receipts.finish(key, account, route, error.status_code, {'detail': error.detail})
            raise
        except Exception:
            receipts.abandon(key, account, route)
            raise
        receipts.finish(key, account, route, 200, result)
        return result
    call.__signature__ = inspect.signature(function, eval_str=True)
    return call
