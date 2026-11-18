"""Optional protocol-one status, independent of acquisition health."""
import json
import threading
import time

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.exceptions import FailureKind, SourceFailure


class Fact(BaseModel):
    model_config = ConfigDict(strict=True)
    label: str
    value: str | None = None
    tip: str | None = None


class Action(BaseModel):
    model_config = ConfigDict(strict=True)
    id: str
    label: str


class Toggle(Action):
    value: bool


class SourceStatus(BaseModel):
    model_config = ConfigDict(strict=True)
    revision: str | None = None
    facts: list[Fact] = Field(default_factory=list)
    actions: list[Action] = Field(default_factory=list)
    toggles: list[Toggle] = Field(default_factory=list)
    warning: str | None = None


class StatusCache:
    def __init__(self, changed=lambda *args: None, *, now=time.time, ledger=None):
        self.changed, self.now = changed, now
        self.rows = {}
        self.revisions = {}
        self.ledger = ledger
        if ledger:
            with ledger.lock:
                self.revisions = {row[0]: json.loads(row[1]) for row in ledger.db.execute("SELECT id,data FROM source_status")}
        self.lock = threading.RLock()

    def refresh(self, source, *, force=False):
        with self.lock:
            previous, checked = self.rows.get(source.id, (SourceStatus(), 0))
            if not force and self.now() - checked < 60:
                return previous
            try:
                result = source.call('status', {}, 30_000)
            except SourceFailure as error:
                # Older v1 plugins use a typed bug for an unknown method.
                if error.kind != FailureKind.BUG:
                    raise
                result = {}
            return self.accept(source.id, result)

    def accept(self, source_id, result):
        with self.lock:
            try:
                status = SourceStatus.model_validate(result)
            except ValidationError as error:
                raise SourceFailure('Invalid source status response.') from error
            now = self.now()
            record = self.revisions.setdefault(source_id, {'revision': None, 'since': now, 'pending': []})
            if status.revision is not None:
                if record['revision'] is not None and record['revision'] != status.revision:
                    record['pending'].append([record['since'], now, status.revision])
                if record['revision'] != status.revision:
                    record.update(revision=status.revision, since=now)
            self.rows[source_id] = status, now
            # Commit intent before entering acquisition; a crash cannot consume
            # the revision without also recording its retry window.
            self._save(source_id, record)
            remaining = []
            for since, until, revision in record['pending']:
                if not self.changed(source_id, since, until, revision):
                    remaining.append([since, until, revision])
            record['pending'] = remaining
            self._save(source_id, record)
            return status

    def _save(self, source_id, record):
        if self.ledger:
            with self.ledger.lock, self.ledger.db:
                self.ledger.db.execute('INSERT OR REPLACE INTO source_status VALUES(?,?)', (source_id, json.dumps(record)))

    def forget(self, source_id, *, permanent=False):
        with self.lock:
            self.rows.pop(source_id, None)
            if permanent:
                self.revisions.pop(source_id, None)
                if self.ledger:
                    with self.ledger.lock, self.ledger.db:
                        self.ledger.db.execute('DELETE FROM source_status WHERE id=?', (source_id,))

    def action(self, source, action_id, value=None):
        params = {'id': action_id}
        if value is not None:
            params['value'] = value
        return self.accept(source.id, source.call('action', params, 120_000))
