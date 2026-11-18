"""Short-lived filesystem receipts shared by publication and native hints."""
import threading
import time
from pathlib import Path


class ExpectedPublishes:
    def __init__(self, ttl=10.0):
        self.ttl = ttl
        self.lock = threading.RLock()
        self.paths = {}

    def expect(self, path):
        with self.lock:
            now = time.monotonic()
            self.paths = {p: value for p, value in self.paths.items() if value[0] > now}
            self.paths[Path(path).resolve()] = (now + self.ttl, None)

    def landed(self, path):
        with self.lock:
            self.paths[Path(path).resolve()] = (time.monotonic() + self.ttl, self.signature(path))

    @staticmethod
    def signature(path):
        try:
            stat = Path(path).stat()
            return stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
        except OSError:
            return ()

    def contains(self, path):
        with self.lock:
            receipt = self.paths.get(Path(path).resolve())
            return bool(receipt and receipt[0] > time.monotonic()
                        and (receipt[1] is None or receipt[1] == self.signature(path)))


expected_publishes = ExpectedPublishes()
