"""One ffmpeg selection for every backend consumer."""
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache
from importlib.resources import files
from pathlib import Path
from typing import Literal

from app.exceptions import ConfigurationError


@dataclass(frozen=True)
class FFmpeg:
    path: str
    version: str
    source: Literal["env", "system", "bundled"]


def bundled_ffmpeg_path() -> str:
    """The imageio binary, staged beside frozen backends (never on PATH)."""
    if getattr(sys, "frozen", False):
        name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
        return str(Path(sys.executable).parent / "ffmpeg" / name)
    import imageio_ffmpeg.binaries as binaries

    # Do not use get_ffmpeg_exe(): IMAGEIO_FFMPEG_EXE and conda would introduce
    # extra resolution rules and could misreport a system binary as bundled.
    return next(str(p) for p in files(binaries).iterdir()
                if p.name.startswith("ffmpeg-") and p.is_file())


def probe_ffmpeg(path: str) -> str:
    """Validate a concrete executable and read its version, with a bounded wait."""
    if not path or not Path(path).is_file():
        raise ValueError("ffmpeg path is not a file")
    try:
        result = subprocess.run([path, "-version"], capture_output=True, text=True,
                                timeout=5, check=True)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise ValueError("ffmpeg cannot run") from exc
    match = re.match(r"ffmpeg version\s+(\S+)", result.stdout)
    if not match:
        raise ValueError("executable does not report an ffmpeg version")
    return match[1]


_cached_version = lru_cache(maxsize=None)(probe_ffmpeg)


def resolve_ffmpeg_info() -> FFmpeg:
    """Runnable override → installed ffmpeg → imageio's packaged fallback.

    Successful version probes are cached per path, so settings reads and new
    ConfigManagers never launch repeated version subprocesses.
    """
    candidates = [(os.getenv("KROBI_FFMPEG_PATH"), "env"), (shutil.which("ffmpeg"), "system")]
    if sys.platform == "darwin":
        candidates.extend((f"{directory}/ffmpeg", "system")
                          for directory in ("/opt/homebrew/bin", "/usr/local/bin"))
    for path, source in candidates:
        if path:
            try:
                absolute = str(Path(path).absolute())
                return FFmpeg(absolute, _cached_version(absolute), source)
            except ValueError:
                pass
    try:
        path = bundled_ffmpeg_path()
        return FFmpeg(path, _cached_version(path), "bundled")
    except (ImportError, StopIteration, ValueError) as exc:
        raise ConfigurationError("No runnable ffmpeg found") from exc


def resolve_ffmpeg() -> str:
    return resolve_ffmpeg_info().path


def decode_mono_pcm(path: Path, ffmpeg_path: str):
    """Decode using the configured binary, with native sample rate and mono float32."""
    import numpy as np

    result = subprocess.run(
        [ffmpeg_path, '-v', 'error', '-nostdin', '-i', str(path), '-vn',
         '-ac', '1', '-rematrix_maxval', '1.0', '-acodec', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
        capture_output=True, check=True, timeout=300,
    )
    return np.frombuffer(result.stdout, dtype='<f4')
