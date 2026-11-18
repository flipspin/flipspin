"""Shared file discovery rules for listings and analysis retention."""
import os
from pathlib import Path

AUDIO_EXTENSIONS = {'.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac'}
SKIP_DIRS = frozenset({'cover', 'temp', 'incoming', 'staging'})


def walk_library(base_dir: Path, *, onerror=None):
    """Walk visible library folders in stable order; optionally surface I/O errors."""
    for root, dirs, files in os.walk(base_dir, onerror=onerror):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in SKIP_DIRS)
        yield root, dirs, files
