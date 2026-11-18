"""Identify the running archive, before an app update can replace it on disk."""
import hashlib
import sys
from pathlib import Path


def executable_build_id(executable: Path) -> str:
    with executable.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


# Resolve during startup, never lazily in /api/status: the path can already
# contain a different archive by the time an orphan is asked who it is.
BUILD_ID = executable_build_id(Path(sys.executable)) if getattr(sys, "frozen", False) else None
