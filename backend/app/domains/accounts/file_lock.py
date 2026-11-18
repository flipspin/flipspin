"""Serialize account-file operations by the server and recovery CLI.

Keep a separate lock inode across atomic data-file replacement.
Thread locking remains reentrant for nested claim and device operations.
See docs/security.md#account-storage.
"""
import os
import threading
from pathlib import Path


class AccountFileLock:
    def __init__(self, path: Path):
        self.path = path.with_name(path.name + ".lock")
        self._thread = threading.RLock()
        self._depth = 0
        self._fd = None

    def __enter__(self):
        self._thread.acquire()
        try:
            if self._depth == 0:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
                try:
                    if os.name == "nt":
                        import msvcrt
                        if os.fstat(fd).st_size == 0:
                            os.write(fd, b"\0")
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd, fcntl.LOCK_EX)
                except BaseException:
                    os.close(fd)
                    raise
                self._fd = fd
            self._depth += 1
            return self
        except BaseException:
            self._thread.release()
            raise

    def __exit__(self, *_):
        try:
            self._depth -= 1
            if self._depth == 0:
                # Closing also releases the OS lock, even on exceptions.
                os.close(self._fd)
                self._fd = None
        finally:
            self._thread.release()
