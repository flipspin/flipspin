"""Adapters for the stores affected by forgetting a missing recording."""
import os
from uuid import uuid4

from app.domains.lyrics.models import LyricsRecord, PendingTrack
from app.infra.idempotency import database


class PlayReferences:
    TABLES = {'plays': 'track_key', 'plays_baselines': 'track_key', 'play_events': 'track_key'}

    def __init__(self, path):
        self.path = path

    def paths(self):
        with database(self.path) as db:
            return {r[0] for table in self.TABLES for r in db.execute(f'SELECT DISTINCT track_key FROM {table}')}

    def snapshot(self, rel):
        with database(self.path) as db:
            result = {}
            for table in self.TABLES:
                cursor = db.execute(f'SELECT * FROM {table} WHERE track_key=?', (rel,))
                names = [c[0] for c in cursor.description]
                result[table] = [dict(zip(names, row, strict=True)) for row in cursor]
            return result

    def drop(self, rel, snapshot):
        with database(self.path) as db:
            for table in self.TABLES:
                db.execute(f'DELETE FROM {table} WHERE track_key=?', (rel,))

    def restore(self, rel, snapshot):
        with database(self.path) as db:
            for table, rows in snapshot.items():
                for row in rows:
                    db.execute(f'INSERT OR IGNORE INTO {table} ({",".join(row)}) VALUES ({",".join("?" for _ in row)})', tuple(row.values()))


class LyricReferences:
    def __init__(self, repository):
        self.repository = repository

    def snapshot(self, rel):
        record = self.repository.get_record(rel)
        pending = next((p for p in self.repository.pending() if p.rel_path == rel), None)
        return {'record': record.to_dict() if record else None, 'pending': pending.to_dict() if pending else None}

    def drop(self, rel, snapshot):
        self.repository.remove_record(rel)
        self.repository.clear_pending(rel)

    def restore(self, rel, snapshot):
        if snapshot['record'] and not self.repository.get_record(rel):
            self.repository.put_record(LyricsRecord.from_dict(rel, snapshot['record']))
        if snapshot['pending']:
            self.repository.mark_pending(PendingTrack.from_dict(rel, snapshot['pending']))


class StemReferences:
    def __init__(self, repository):
        self.repository = repository

    def snapshot(self, rel):
        path = self.repository.track_dir(*rel.split('/'))
        return {'present': path.is_dir(), 'token': uuid4().hex}

    def recycle(self, rel, token):
        path = self.repository.track_dir(*rel.split('/'))
        return path, path.parent / '.missing-recycle' / token / path.name

    def drop(self, rel, snapshot):
        path, recycle = self.recycle(rel, snapshot['token'])
        if path.is_dir() and not recycle.exists():
            recycle.parent.mkdir(parents=True, exist_ok=True)
            os.replace(path, recycle)

    def restore(self, rel, snapshot):
        path, recycle = self.recycle(rel, snapshot['token'])
        if snapshot['present'] and recycle.exists():
            if path.exists():
                raise ValueError('Stems changed since removal')
            path.parent.mkdir(parents=True, exist_ok=True)
            os.replace(recycle, path)
