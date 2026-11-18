"""Hash-first, account-scoped upload receipts. Only Pipeline publishes and links."""
import asyncio
import hashlib
import json
import logging
import os
import shutil
import threading
from pathlib import Path

from mutagen import File as AudioFile
from pydantic import BaseModel, Field, field_validator
from typing import Literal

from app.domains.music.public import owned_paths
from app.infra.identity import Principal
from app.infra.media_requests import TrackDownloadRequest
from app.infra.tasks import spawn_background
from app.utils.path_safety import safe_open_path
from app.utils.library_paths import rel_path_for

from .models import AcquisitionError

AUDIO = {'.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.aac', '.wma'}
Failure = Literal['no-es-audio', 'archivo-danado', 'muy-grande', 'sin-espacio', 'fallo-subida']


class UploadFile(BaseModel):
    id: str = Field(min_length=1, max_length=255)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    name: str = Field(min_length=1, max_length=1000)
    bytes: int = Field(ge=0)
    title: str | None = Field(default=None, max_length=500)
    artist: str | None = Field(default=None, max_length=500)
    duration_s: float | None = Field(default=None, ge=0, le=86400)

    @field_validator('name')
    @classmethod
    def valid_name(cls, value):
        if '\x00' in value or Path(value.replace('\\', '/')).name in ('', '.', '..'):
            raise ValueError('invalid filename')
        return value


class Check(BaseModel):
    files: list[UploadFile] = Field(min_length=1, max_length=5000)


class Batch(Check):
    files: list[UploadFile] = Field(min_length=1, max_length=100000)
    id: str = Field(pattern=r'^[a-zA-Z0-9-]{1,80}$')


class Decision(BaseModel):
    duplicates: Literal['use-nest', 'keep-both'] = 'use-nest'


class UploadItemView(BaseModel):
    id: str
    sha256: str
    name: str
    bytes: int
    offset: int
    state: Literal['por-subir', 'ya-estaba', 'subiendo', 'importando', 'agregada', 'no-apta', 'fallida']
    reason: Failure | None = None
    duplicate: bool = False
    already: bool = False


class CheckView(BaseModel):
    files: list[UploadItemView]
    maxBytes: int


class BatchView(CheckView):
    id: str
    phase: Literal['resumen', 'subiendo', 'terminado']


class UploadSpace(BaseModel):
    freeBytes: int
    floorBytes: int


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def metadata(path):
    if path.suffix.lower() not in AUDIO:
        raise AcquisitionError('no-es-audio', 415)
    try:
        audio = AudioFile(path, easy=True)
        if audio is None or not audio.info.length or audio.info.length <= 0:
            raise ValueError('invalid audio')
        tags = audio.tags or {}
        def tag(name, id3):
            value = tags.get(name) or tags.get(id3)
            value = getattr(value, 'text', value)
            return str(value[0]).strip() if value else ''
        return {'title': tag('title', 'TIT2') or path.stem,
                'artist': tag('artist', 'TPE1'), 'album': tag('album', 'TALB'),
                'duration_s': audio.info.length}
    except Exception as error:
        raise AcquisitionError('archivo-danado', 422) from error


class Uploads:
    def __init__(self, pipeline, *, max_bytes=None):
        self.pipeline, self.ledger = pipeline, pipeline.ledger
        self.max_bytes = max_bytes if max_bytes is not None else int(os.getenv('KROBI_UPLOAD_MAX_BYTES', str(500 * 1024 * 1024)))
        self.lock = threading.RLock()
        self._active = set()
        self._processing = asyncio.Lock()
        self._maintaining = False

    def _query(self, sql, args=()):
        with self.ledger.lock:
            return [dict(r) for r in self.ledger.db.execute(sql, args)]

    def _write(self, sql, args=()):
        with self.ledger.lock, self.ledger.db:
            self.ledger.db.execute(sql, args)
            self.ledger._bump()

    def _index(self):
        # Include existing household audio, not just files uploaded by this door.
        indexed = {r['path']: r for r in self._query('SELECT * FROM upload_hashes')}
        for path in self.pipeline.root.rglob('*'):
            if path.suffix.lower() not in AUDIO or not path.is_file() or path.is_symlink():
                continue
            try:
                path = safe_open_path(self.pipeline.root, path)
                stat = path.stat()
                old = indexed.get(str(path))
                if old and old['size'] == stat.st_size and old['mtime'] == stat.st_mtime_ns:
                    continue
                sha = digest(path)
                self._write('DELETE FROM upload_hashes WHERE path=?', (str(path),))
                self._write('INSERT OR IGNORE INTO upload_hashes VALUES(?,?,?,?)',
                            (sha, str(path), stat.st_size, stat.st_mtime_ns))
            except (OSError, ValueError):
                continue

    def _hit(self, sha):
        rows = self._query('SELECT path FROM upload_hashes WHERE sha256=?', (sha,))
        if rows:
            try:
                path = safe_open_path(self.pipeline.root, Path(rows[0]['path']))
                if path.is_file() and rel_path_for(self.pipeline.root, path) and digest(path) == sha:
                    return str(path)
            except (OSError, ValueError):
                pass
        return None

    def _preview(self, file, principal):
        reason = 'no-es-audio' if Path(file.name).suffix.lower() not in AUDIO else 'muy-grande' if file.bytes > self.max_bytes else 'archivo-danado' if file.bytes == 0 else None
        hit = self._hit(file.sha256)
        duplicate = None
        if not hit and file.title and file.artist and file.duration_s:
            hits = owned_paths(self.pipeline.ownership, self.pipeline.root, [file.model_dump()])
            duplicate = str(hits[0]) if 0 in hits else None
        # W10: never disclose a household match (or recording candidate) to a member.
        public_hit = hit if principal.is_owner else None
        return {'id': file.id, 'sha256': file.sha256, 'name': file.name, 'bytes': file.bytes,
                'offset': 0, 'state': 'no-apta' if reason else 'ya-estaba' if public_hit else 'por-subir',
                'reason': reason, 'duplicate': bool(duplicate and principal.is_owner), 'already': bool(public_hit)}, hit, duplicate

    def check(self, data, principal):
        with self.lock:
            self.expire()
            self._index()
            return {'files': [self._preview(f, principal)[0] for f in data.files], 'maxBytes': self.max_bytes}

    def create(self, data, principal):
        with self.lock:
            old = self._query('SELECT * FROM upload_batches WHERE id=?', (data.id,))
            if old:
                self._batch(data.id, principal)
                expected = {r['sha256'] for r in self.rows(data.id, principal)}
                if expected != {f.sha256 for f in data.files}:
                    raise AcquisitionError('idempotency-conflict', 422)
                return self.view(data.id, principal)
            self.check(data, principal)
            # Reserve the full remaining byte budget before accepting any bytes.
            needed = sum(f.bytes for f in data.files if not self._hit(f.sha256) and f.bytes <= self.max_bytes)
            reserved = self._query("SELECT coalesce(sum(json_extract(body,'$.bytes')-offset),0) AS n FROM upload_items WHERE state IN ('por-subir','subiendo')")[0]['n']
            if shutil.disk_usage(self.pipeline.data).free < self.pipeline.floor_bytes + needed + reserved:
                raise AcquisitionError('sin-espacio', 507)
            for file in data.files:
                previous = self._query('SELECT batch,state FROM upload_items WHERE account=? AND sha256=?', (principal.user_id, file.sha256))
                if previous and previous[0]['state'] not in ('agregada', 'ya-estaba'):
                    active = self._query("SELECT id FROM upload_batches WHERE id=? AND phase='subiendo'", (previous[0]['batch'],))
                    if active:
                        raise AcquisitionError('upload-already-active')
            with self.ledger.lock, self.ledger.db:
                self.ledger.db.execute("INSERT INTO upload_batches VALUES(?,?,?,'resumen','use-nest',?)",
                                       (data.id, principal.user_id, json.dumps(principal.__dict__), self.ledger.now()))
                self.ledger.db.execute('INSERT INTO upload_followups(batch,total) VALUES(?,?)', (data.id, len(data.files)))
                self.ledger._bump()
            seen, items = set(), []
            for file in data.files:
                if file.sha256 in seen:
                    continue
                seen.add(file.sha256)
                preview, hit, duplicate = self._preview(file, principal)
                previous = self._query('SELECT * FROM upload_items WHERE account=? AND sha256=?', (principal.user_id, file.sha256))
                if previous and previous[0]['state'] not in ('agregada', 'ya-estaba'):
                    batch = self._query('SELECT phase FROM upload_batches WHERE id=?', (previous[0]['batch'],))
                    if batch and batch[0]['phase'] == 'subiendo':
                        raise AcquisitionError('upload-already-active')
                if not previous:
                    self._write('INSERT INTO upload_items(account,sha256,batch,body,state,reason,hit,duplicate,updated,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                                (principal.user_id, file.sha256, data.id, json.dumps({**file.model_dump(), '_already': preview['already']}), preview['state'], preview['reason'], hit, duplicate, self.ledger.now(), self.ledger.now()))
                elif previous[0]['state'] not in ('agregada', 'ya-estaba'):
                    # A partial stays with its staging batch; the new manifest references it.
                    self._write('UPDATE upload_items SET hit=?,duplicate=?,updated=? WHERE account=? AND sha256=?',
                                (hit, duplicate, self.ledger.now(), principal.user_id, file.sha256))
                if previous and previous[0]['state'] == 'agregada':
                    body = json.loads(previous[0]['body'])
                    body['_already'] = True
                    self._write('UPDATE upload_items SET body=? WHERE account=? AND sha256=?', (json.dumps(body), principal.user_id, file.sha256))
                self._write('INSERT INTO upload_members VALUES(?,?,?,?)', (data.id, file.sha256, file.id, len(items)))
                items.append({'item': Path(file.name).name, 'detail': {'sha256': file.sha256}})
            self.ledger.start('upload', 'Subir música', items, principal, job_id=data.id)
            return self.view(data.id, principal)

    def _batch(self, id, principal):
        rows = self._query('SELECT * FROM upload_batches WHERE id=? AND account=?', (id, principal.user_id))
        if not rows:
            raise AcquisitionError('not-found', 404)
        return rows[0]

    def rows(self, id, principal):
        self._batch(id, principal)
        return self._query('''SELECT i.*,m.client_id,m.idx FROM upload_members m JOIN upload_items i
            ON i.sha256=m.sha256 WHERE m.batch=? AND i.account=? ORDER BY m.idx''', (id, principal.user_id))

    def view(self, id, principal):
        batch = self._batch(id, principal)
        files = []
        for row in self.rows(id, principal):
            file = json.loads(row['body'])
            state = row['state']
            if batch['phase'] == 'resumen' and state == 'agregada':
                state = 'ya-estaba'
            elif not principal.is_owner and state == 'ya-estaba':
                state = 'agregada' if batch['phase'] != 'resumen' else 'por-subir'
            files.append({'id': row['client_id'], 'sha256': row['sha256'], 'name': file['name'], 'bytes': file['bytes'],
                          'offset': row['offset'], 'state': state, 'reason': row['reason'],
                          'duplicate': bool(row['duplicate'] and principal.is_owner), 'already': bool(file.get('_already'))})
        return {'id': id, 'phase': batch['phase'], 'files': files, 'maxBytes': self.max_bytes}

    def start(self, id, principal, choice='use-nest'):
        self.ensure_maintenance()
        with self.lock:
            batch = self._batch(id, principal)
            if batch['phase'] in ('terminado', 'subiendo'):
                self.kick(id)
                return self.view(id, principal)
            self._write("UPDATE upload_batches SET phase='subiendo',choice=?,updated=? WHERE id=?", (choice, self.ledger.now(), id))
            self.ledger.running(id, self.ledger.get(id)['attempt'])
            self.kick(id)
            return self.view(id, principal)

    def kick(self, id):
        if id not in self._active:
            self._active.add(id)
            async def work():
                try:
                    async with self._processing:
                        await self.process(id)
                finally:
                    self._active.discard(id)
            spawn_background(work())

    def _part(self, row):
        file = json.loads(row['body'])
        name = Path(file['name'].replace('\\', '/')).name
        return self.pipeline.incoming / row['batch'] / row['sha256'] / name

    def item(self, id, sha, principal):
        return next((r for r in self.rows(id, principal) if r['sha256'] == sha), None)

    def head(self, id, sha, principal):
        with self.lock:
            self.expire()
            row = self.item(id, sha, principal)
            if row is None:
                raise AcquisitionError('not-found', 404)
            self._write('UPDATE upload_items SET updated=? WHERE account=? AND sha256=?', (self.ledger.now(), principal.user_id, sha))
            return row

    def append(self, id, sha, principal, offset, chunk, checksum=None):
        with self.lock:
            row = self.head(id, sha, principal)
            if self._batch(id, principal)['phase'] != 'subiendo' or row['state'] not in ('por-subir', 'subiendo'):
                raise AcquisitionError('upload-not-active')
            if offset != row['offset']:
                raise AcquisitionError('offset-mismatch')
            if checksum is not None and hashlib.sha256(chunk).hexdigest() != checksum:
                raise AcquisitionError('checksum-mismatch', 460)
            size = json.loads(row['body'])['bytes']
            if offset + len(chunk) > size or size > self.max_bytes:
                raise AcquisitionError('muy-grande', 413)
            if shutil.disk_usage(self.pipeline.data).free < self.pipeline.floor_bytes + len(chunk):
                self.fail(row, 'sin-espacio')
                raise AcquisitionError('sin-espacio', 507)
            path = self._part(row)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('r+b' if path.exists() else 'w+b') as output:
                # A crash after fsync but before receipt commits discards the uncommitted tail.
                output.truncate(offset)
                output.seek(offset)
                output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            self._write("UPDATE upload_items SET offset=?,state=?,updated=? WHERE account=? AND sha256=?",
                        (offset+len(chunk), 'importando' if offset+len(chunk) == size else 'subiendo', self.ledger.now(), principal.user_id, sha))
            return self.item(id, sha, principal)

    def fail(self, row, reason):
        self._write("UPDATE upload_items SET state='fallida',reason=? WHERE account=? AND sha256=?", (reason, row['account'], row['sha256']))

    async def process(self, id):
        batch_rows = self._query('SELECT * FROM upload_batches WHERE id=?', (id,))
        if not batch_rows:
            return
        principal = Principal(**json.loads(batch_rows[0]['principal']))
        for row in self.rows(id, principal):
            if self._batch(id, principal)['phase'] != 'subiendo':
                break
            try:
                if row['state'] in ('no-apta', 'fallida', 'agregada'):
                    continue
                # Members transmit the same bytes and get the same outcomes as a new file.
                hit = row['hit']
                if row['state'] not in ('importando', 'ya-estaba') and not hit:
                    continue
                file = json.loads(row['body'])
                path = self._part(row)
                wanted = {'title': file.get('title') or Path(file['name']).stem, 'artist': file.get('artist') or '', 'duration_s': file.get('duration_s')}
                if row['state'] == 'importando':
                    # The writer saves its actual candidate before publishing,
                    # including a collision suffix. Never derive it from the sha.
                    if row['published_path']:
                        final = Path(row['published_path'])
                        if await asyncio.to_thread(final.exists):
                            final = await asyncio.to_thread(safe_open_path, self.pipeline.root, final)
                            if await asyncio.to_thread(final.is_file) and await asyncio.to_thread(digest, final) == row['sha256']:
                                hit = str(final)
                    if not hit and not path.exists():
                        raise AcquisitionError('fallo-subida')
                    if not hit:
                        if await asyncio.to_thread(digest, path) != row['sha256']:
                            path.unlink(missing_ok=True)
                            self._write('UPDATE upload_items SET offset=0 WHERE account=? AND sha256=?', (row['account'], row['sha256']))
                            raise AcquisitionError('archivo-danado')
                        wanted = await asyncio.to_thread(metadata, path)
                        hit = self._hit(row['sha256'])
                        if not hit and batch_rows[0]['choice'] == 'use-nest':
                            hits = await asyncio.to_thread(owned_paths, self.pipeline.ownership, self.pipeline.root, [wanted])
                            hit = str(hits[0]) if 0 in hits else None
                source_album = Path(file['name'].replace('\\', '/')).parent.name
                clean = TrackDownloadRequest._clean_filename
                artist = clean(wanted.get('artist') or '') or 'Unknown Artist'
                album = clean(wanted.get('album') or source_album) or 'Unknown Album'
                body = {'kind': 'song', 'provider': 'upload', 'provider_id': row['sha256'], 'title': wanted['title'],
                        'tracks': [{**wanted, 'album': album}], 'folder': artist, '_upload_path': str(path),
                        '_upload_batch': id}
                request_id = row['request_id']
                if request_id:
                    body = self.pipeline.store.work(request_id)['body']
                    request = self.pipeline.store.get(request_id, principal.user_id)
                    if request['state'] in ('fallido', 'parcial'):
                        self.pipeline.retry(request_id, principal, schedule=False)
                else:
                    request, _ = self.pipeline.store.create(body, principal)
                    request_id = request['id']
                    self._write('UPDATE upload_items SET request_id=? WHERE account=? AND sha256=?', (request_id, row['account'], row['sha256']))
                requests = self.pipeline._requests(body)
                results = await self.pipeline.run(request_id, requests=requests, hits={0: Path(hit)} if hit else None)
                view = self.pipeline.store.get(request_id, principal.user_id)
                if view['state'] != 'completo':
                    raise AcquisitionError('fallo-subida')
                final = Path(hit) if hit else results[0].file_path if results else Path(
                    self.item(id, row['sha256'], principal)['published_path'])
                # Only byte matches may populate the content index.
                if final.is_file() and digest(final) == row['sha256']:
                    stat = final.stat()
                    self._write('INSERT OR REPLACE INTO upload_hashes VALUES(?,?,?,?)', (row['sha256'], str(final), stat.st_size, stat.st_mtime_ns))
                path.unlink(missing_ok=True)
                self._write("UPDATE upload_items SET state='agregada',reason=NULL,offset=?,hit=? WHERE account=? AND sha256=?",
                            (file['bytes'], str(final), row['account'], row['sha256']))
            except Exception as error:
                logging.getLogger(__name__).exception('upload item failed')
                reason = getattr(error, 'reason', 'fallo-subida')
                self.fail(row, reason if reason in ('no-es-audio', 'archivo-danado', 'muy-grande', 'sin-espacio') else 'fallo-subida')
            else:
                # Notify each publication immediately, even when this pass has
                # many ready items. Reused household files are not publications.
                with self.lock:
                    self._complete_batch(id, paths=self.pipeline.published_paths(upload_batch=id, request_id=request_id), final=False)
        self.reconcile(id, principal)

    def reconcile(self, id, principal):
        with self.lock:
            rows = self.rows(id, principal)
            job = self.ledger.get(id)
            if self._batch(id, principal)['phase'] != 'subiendo':
                return
            for row in rows:
                if row['state'] in ('agregada', 'no-apta', 'fallida'):
                    self.ledger.outcome(id, '', idx=row['idx'], success=row['state'] == 'agregada', reason=row['reason'])
            final = all(r['state'] in ('agregada', 'no-apta', 'fallida') for r in rows)
            self._complete_batch(id, final=final)
            if final:
                self._write("UPDATE upload_batches SET phase='terminado' WHERE id=?", (id,))
                self.ledger.finish(id, job['attempt'])

    def _complete_batch(self, id, *, paths=None, final=True):
        paths = dict.fromkeys(paths if paths is not None else self.pipeline.published_paths(upload_batch=id))
        pending = [path for path in paths if not self._query(
            'SELECT 1 FROM upload_completions WHERE batch=? AND path=?', (id, str(path)))]
        followup = self._query('SELECT * FROM upload_followups WHERE batch=?', (id,))[0]
        if pending:
            self.pipeline.complete_batch(pending, origin='upload', batch_total=followup['total'], refresh=False)
            with self.ledger.lock, self.ledger.db:
                self.ledger.db.executemany('INSERT OR IGNORE INTO upload_completions VALUES(?,?)', ((id, str(path)) for path in pending))
                self.ledger.db.execute('UPDATE upload_followups SET refresh_pending=1 WHERE batch=?', (id,))
                self.ledger._bump()
        # Pipeline.run has already refreshed each published album. Retain the
        # follow-up receipt for replay without requesting another full scan.
        since = followup['refreshed_at']
        if since is None:
            since = self._query('SELECT updated FROM upload_batches WHERE id=?', (id,))[0]['updated']
        if (pending or followup['refresh_pending']) and (
                (final and followup['refreshed_at'] is None) or self.ledger.now() - since >= 60):
            self._write('UPDATE upload_followups SET refresh_pending=0,refreshed_at=? WHERE batch=?', (self.ledger.now(), id))

    def stop(self, id, principal):
        with self.lock:
            batch = self._batch(id, principal)
            self._write("UPDATE upload_batches SET phase='terminado' WHERE id=?", (id,))
            self.ledger.finish(id, self.ledger.get(id)['attempt'], cancelled=True)
            if batch['phase'] == 'subiendo':
                self._complete_batch(id)
            return self.view(id, principal)

    def retry(self, id, principal):
        with self.lock:
            batch = self._batch(id, principal)
            job = self.ledger.get(id)
            if batch['phase'] == 'subiendo' and job['attempt'] > 1:
                return self.view(id, principal)
            if batch['phase'] != 'terminado' or job['attempt'] >= 20:
                raise AcquisitionError('cannot-retry')
            selected = [r for r in self.rows(id, principal) if r['state'] == 'fallida']
            with self.ledger.lock, self.ledger.db:
                self.ledger.db.execute("UPDATE jobs SET state='queued',attempt=attempt+1,ended_at=NULL WHERE id=?", (id,))
                for row in selected:
                    self.ledger._insert(id, row['idx'], job['attempt']+1, {'item': json.loads(row['body'])['name']})
            for row in selected:
                complete = self._part(row).is_file() and self._part(row).stat().st_size == json.loads(row['body'])['bytes']
                self._write('UPDATE upload_items SET state=?,reason=NULL WHERE account=? AND sha256=?',
                            ('importando' if complete else 'por-subir', row['account'], row['sha256']))
            self.ledger.running(id, job['attempt']+1)
            self._write("UPDATE upload_batches SET phase='subiendo' WHERE id=?", (id,))
            return self.start(id, principal, batch['choice'])

    def expire(self):
        # Run on requests and on the server's periodic recovery loop.
        with self.lock:
            stale = self._query("SELECT * FROM upload_items WHERE state IN ('por-subir','subiendo') AND updated<?", (self.ledger.now()-86400,))
            for row in stale:
                shutil.rmtree(self._part(row).parent, ignore_errors=True)
                self._write("UPDATE upload_items SET state='fallida',reason='fallo-subida',offset=0 WHERE account=? AND sha256=?", (row['account'], row['sha256']))
            for id in {r['batch'] for r in stale}:
                batch = self._query('SELECT principal FROM upload_batches WHERE id=?', (id,))
                if batch:
                    self.reconcile(id, Principal(**json.loads(batch[0]['principal'])))
            # Finish persisted follow-up bookkeeping after a stop or restart.
            for row in self._query('SELECT batch FROM upload_followups WHERE refresh_pending=1'):
                self._complete_batch(row['batch'], paths=(), final=False)

    async def maintain(self):
        while True:
            await asyncio.sleep(60)
            await asyncio.to_thread(self.expire)

    def ensure_maintenance(self):
        if not self._maintaining:
            self._maintaining = True
            spawn_background(self.maintain())

    def recover(self):
        self.ensure_maintenance()
        self.expire()
        for batch in self._query("SELECT id FROM upload_batches WHERE phase='subiendo'"):
            self.kick(batch['id'])
