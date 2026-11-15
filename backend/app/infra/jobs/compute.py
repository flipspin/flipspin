"""Durable household kind policies and device limits beside the lease queue."""
import json

from app.infra import env_sources
from .placement import decide

MEMORY = 8 << 30
NEST_LIMITS = {
    'KROBI_NEST_CPU_PERCENT': ('nest_cpu_percent', 'cpuPercent'),
    'KROBI_NEST_MAX_TEMP_C': ('nest_max_temp_c', 'maxTempC'),
    'KROBI_NEST_RESUME_TEMP_C': ('nest_resume_temp_c', 'resumeTempC'),
}
DEFAULTS = {'align': 'helpers', 'transcribe': 'helpers', 'stems': 'helpers',
            'analysis': 'anywhere', 'replaygain': 'anywhere', 'fingerprint': 'anywhere',
            'embeddings': 'helpers-then-nest'}


class ComputeSettings:
    def __init__(self, ledger, config, *, nest_memory_bytes=None, changes=None):
        self.changes = changes
        self.ledger, self.config = ledger, config
        with ledger.lock, ledger.db:
            ledger.db.executescript('''
                CREATE TABLE IF NOT EXISTS kind_policy (kind TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS worker_limits (worker_id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS compute_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            ''')
            if not ledger.db.execute("SELECT 1 FROM compute_state WHERE key='migrated'").fetchone():
                for kind, placement in DEFAULTS.items():
                    if getattr(config, 'nest_processes', False) and (kind not in ('align', 'transcribe', 'stems') or nest_memory_bytes is not None and nest_memory_bytes >= MEMORY):
                        placement = 'helpers-then-nest'
                    data = self.default_policy(kind, placement)
                    if kind == 'stems':
                        data['libraryPass'] = 'auto' if config.stems_background else 'ask'
                    if kind in ('align', 'transcribe') and config.lyrics_engine_mode == 'local' and nest_memory_bytes is not None and nest_memory_bytes >= MEMORY:
                        data['placement'] = 'anywhere'
                    self._write('kind_policy', 'kind', kind, data)
                self._write('worker_limits', 'worker_id', 'nest', self.default_limits(True, config))
                ledger.db.execute("INSERT INTO compute_state VALUES ('migrated','1')")
        self.apply_compatibility()

    @staticmethod
    def default_policy(kind, placement=None):
        return {'kind': kind, 'placement': placement or DEFAULTS.get(kind, 'helpers'), 'paused': False,
                'nestAfterS': 600, 'libraryPass': 'auto',
                'requiredMemoryBytes': MEMORY if kind in ('align', 'transcribe', 'stems') else 0}

    @staticmethod
    def default_limits(nest=False, config=None):
        return {'pace': 'gentle' if nest else 'fast', 'paused': False, 'onlyCharging': False,
                'window': None,
                'cpuPercent': getattr(config, 'nest_cpu_percent', 50),
                'maxTempC': getattr(config, 'nest_max_temp_c', 85),
                'resumeTempC': getattr(config, 'nest_resume_temp_c', 75),
                'use': {}, 'installEverything': False}

    def _read(self, table, key, identity, default):
        with self.ledger.lock:
            row = self.ledger.db.execute(f'SELECT data FROM {table} WHERE {key}=?', (identity,)).fetchone()
            return json.loads(row[0]) if row else default

    def _write(self, table, key, identity, data):
        self.ledger.db.execute(f'INSERT OR REPLACE INTO {table} ({key},data) VALUES (?,?)', (identity, json.dumps(data)))

    def policy(self, kind):
        return self._read('kind_policy', 'kind', kind, self.default_policy(kind))

    def limits(self, worker):
        data = self._read('worker_limits', 'worker_id', 'nest' if worker.get('nest') else worker['id'],
                          self.default_limits(bool(worker.get('nest'))))
        if worker.get('nest'):
            for env, (attr, field) in NEST_LIMITS.items():
                if env not in env_sources.ENV_KEYS:
                    continue
                data[field] = getattr(self.config, attr)
            data['window'] = None  # Retained on the wire; the nest has no schedule.
        return data

    def locked_limits(self):
        return {field
                for env, (_, field) in NEST_LIMITS.items() if env in env_sources.ENV_KEYS}

    def save_policy(self, kind, values):
        with self.ledger.lock, self.ledger.db:
            data = {**self.policy(kind), **values}
            self._write('kind_policy', 'kind', kind, data)
        self.apply_compatibility()
        if self.changes:
            self.changes.bump('helpers')
        return data

    def save_limits(self, worker, values):
        with self.ledger.lock, self.ledger.db:
            data = {**self.limits(worker), **values}
            if worker.get('nest'):
                data['window'] = None
            self._write('worker_limits', 'worker_id', 'nest' if worker.get('nest') else worker['id'], data)
        self.apply_compatibility()
        if self.changes:
            self.changes.bump('helpers')
        return data

    def delete_worker(self, identity):
        with self.ledger.lock, self.ledger.db:
            self.ledger.db.execute('DELETE FROM worker_limits WHERE worker_id=?', (identity,))
        if self.changes:
            self.changes.bump('helpers')

    @property
    def paused(self):
        with self.ledger.lock:
            row = self.ledger.db.execute("SELECT value FROM compute_state WHERE key='paused'").fetchone()
            return bool(row and row[0] == 'true')

    def pause(self, paused):
        with self.ledger.lock, self.ledger.db:
            self.ledger.db.execute("INSERT OR REPLACE INTO compute_state VALUES ('paused',?)", (json.dumps(paused),))
        if self.changes:
            self.changes.bump('helpers')

    def reason(self, worker, row, now):
        limits = self.limits(worker)
        if limits['use'].get(row['kind']) is False or row['kind'] == 'transcribe' and limits['use'].get('align') is False:
            return 'engine-disabled'
        return decide(self.policy(row['kind']), limits, worker, row, now, paused_all=self.paused)

    def apply_compatibility(self):
        # One-release read aliases; old switches no longer own runtime decisions.
        self.config.nest_processes = any(self.policy(k)['placement'] != 'helpers' for k in DEFAULTS)
        self.config.stems_background = self.policy('stems')['libraryPass'] == 'auto'
        self.config.lyrics_engine_mode = 'agent'
        limits = self.limits({'nest': True})
        for attr, key in [('nest_cpu_percent', 'cpuPercent'), ('nest_max_temp_c', 'maxTempC'),
                          ('nest_resume_temp_c', 'resumeTempC')]:
            setattr(self.config, attr, limits[key])
