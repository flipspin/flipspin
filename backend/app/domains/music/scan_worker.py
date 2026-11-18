"""One coalescing background scanner for hints, retags and periodic discovery."""
import threading
import time

from app.domains.music.scan_watch import LibraryWatch


class ScanWorker:
    def __init__(self, repository, interval=300.0, debounce=0.1, *, watched_interval=1800.0):
        self.repository = repository
        self.fallback_interval = interval
        self.watched_interval = watched_interval
        self.debounce = debounce
        self.condition = threading.Condition()
        self.pending = set()
        self.full = False
        self.deadline = None
        self.running = False
        self.stopping = False
        self.thread = None
        self.watch = LibraryWatch(self)

    @property
    def interval(self):
        return (self.watched_interval if self.watch.following(self.repository.config.base_music_dir)
                else self.fallback_interval)

    def start(self):
        with self.condition:
            if self.thread and self.thread.is_alive():
                return
            self.stopping = False
            self.pending.add('startup')
            self.full = True
            self.deadline = time.monotonic() + self.debounce
            self.thread = threading.Thread(target=self.run, name='library-scan', daemon=True)
            self.thread.start()

    def request(self, reason='changes', *, full=False):
        if full:
            self.repository.scans.store.request_full(self.repository.config.base_music_dir)
        with self.condition:
            self.pending.add(reason)
            self.full |= full
            now = time.monotonic()
            if self.pending == {'filesystem'}:
                self.deadline = now + 5.0
            else:
                self.deadline = min(self.deadline or now + self.debounce, now + self.debounce)
            self.condition.notify_all()

    def status(self):
        with self.condition:
            return {'scanning': self.running, 'pending': bool(self.pending), 'intervalSeconds': self.interval}

    def run(self):
        last_pass = time.monotonic()
        was_watching = False
        while True:
            with self.condition:
                while not self.pending and not self.stopping:
                    watching = self.watch.following(self.repository.config.base_music_dir)
                    if was_watching and not watching:
                        self.pending.add('watcher-failed')
                        self.full = True
                        break
                    remaining = last_pass + self.interval - time.monotonic()
                    if remaining <= 0:
                        break
                    # Recheck a dead observer within the fallback period, without discovery.
                    self.condition.wait(min(remaining, self.fallback_interval))
                if self.stopping:
                    return
                # Debounce bursts; arrivals during a scan become one following pass.
                while self.deadline is not None and not self.stopping:
                    remaining = self.deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self.condition.wait(remaining)
                if self.stopping:
                    return
                reason = ','.join(sorted(self.pending)) or 'periodic'
                full, self.full = self.full, False
                self.pending.clear()
                self.deadline = None
                self.running = True
            try:
                self.watch.follow(self.repository.config.base_music_dir)
                self.repository.refresh(reason=reason, full=full)
            except Exception:
                self.repository.logger.exception('Library scan failed; retaining last good snapshot')
            finally:
                with self.condition:
                    last_pass = time.monotonic()
                    was_watching = self.watch.following(self.repository.config.base_music_dir)
                    self.running = False
                    self.condition.notify_all()

    def stop(self):
        with self.condition:
            self.stopping = True
            self.condition.notify_all()
        if self.thread:
            self.thread.join(timeout=5)
        self.watch.stop()
