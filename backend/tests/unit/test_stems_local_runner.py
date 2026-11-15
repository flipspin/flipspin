"""Local mode: the backend on Apple Silicon drains the stems queue itself.

A fake ``krobi-helper`` (a Python script) speaks the JSON-lines protocol and
writes an out dir, so the runner's claim → subprocess → publish path runs
without a model.
"""
from __future__ import annotations

import logging
import os
import stat
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.domains.helpers.mac_worker import MIN_WORKER_VERSION
from app.domains.stems.repositories import StemsRepository
from app.domains.stems.services import StemsService

pytestmark = pytest.mark.unit

ALBUM, SONG = "Album", "Song.mp3"

FAKE_OK = '''
import json, sys
from pathlib import Path
args = sys.argv[1:]
assert args[0] == "stems"
job = json.loads(Path(args[args.index("--job") + 1]).read_text())
out = Path(args[args.index("--out-dir") + 1]); out.mkdir(parents=True)
print(json.dumps({"event": "phase", "job": job["id"], "phase": "separando", "percent": None}), flush=True)
for s in ("drums", "bass", "vocals", "other"):
    (out / f"{s}.ogg").write_bytes(b"OggS")
(out / "song.json").write_text(json.dumps({"version": 1, "chops": {"full": [{"start": 0, "end": 1, "label": "bar 1"}]}}))
print("library chatter that is not JSON")
print(json.dumps({"event": "done", "job": job["id"], "dir": str(out)}), flush=True)
'''
FAKE_VERDICT = '''
import json
print(json.dumps({"event": "failed", "job": "x", "error": "silencio", "final": True}), flush=True)
'''
FAKE_CRASH = "import sys\nsys.exit(3)\n"


def _engine(tmp_path: Path, body: str) -> SimpleNamespace:
    script = tmp_path / "krobi-helper"
    script.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return SimpleNamespace(binary=script, installed=True, check=lambda: {"version": MIN_WORKER_VERSION, "addons": {"stems": {"ready": True}}}, _engine_env=lambda: dict(os.environ))


def _service(tmp_path: Path, body: str, mode: str = "local") -> StemsService:
    music = tmp_path / "Music"
    (music / ALBUM).mkdir(parents=True)
    (music / ALBUM / SONG).write_bytes(b"x")
    config = SimpleNamespace(
        base_music_dir=music, stems_dir=tmp_path / "stems", lyrics_file=tmp_path / "lyrics.json", temp_dir=tmp_path / "temp"
    )
    logger = logging.getLogger("test.stems")
    return StemsService(
        repository=StemsRepository(config, logger), config=config, logger=logger,
        engine=_engine(tmp_path, body), engine_mode=lambda: mode,
    )


def _wait(service: StemsService, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        thread = service.runner._thread
        if thread is None or not thread.is_alive():
            return
        time.sleep(0.05)
    raise AssertionError("local runner did not finish")


def test_local_mode_splits_and_publishes(tmp_path):
    service = _service(tmp_path, FAKE_OK)
    assert service.request(ALBUM, SONG)["status"] == "queued"
    _wait(service)
    code, manifest = service.status(ALBUM, SONG)
    assert code == 200 and manifest["track"]["album"] == ALBUM
    assert service.stem_file(ALBUM, SONG, "drums").read_bytes() == b"OggS"
    assert service.jobs()["jobs"] == [] and service.jobs()["mode"] == "local"
    assert not list((tmp_path / "temp").iterdir()), "the work dir is removed"


def test_local_mode_records_a_verdict(tmp_path):
    service = _service(tmp_path, FAKE_VERDICT)
    service.request(ALBUM, SONG)
    _wait(service)
    code, body = service.status(ALBUM, SONG)
    assert code == 202 and body["status"] == "failed" and body["error"] == "silencio"


def test_local_mode_retries_a_crash_then_gives_up(tmp_path):
    service = _service(tmp_path, FAKE_CRASH)
    service.request(ALBUM, SONG)
    _wait(service)
    code, body = service.status(ALBUM, SONG)
    assert code == 202 and body["status"] == "failed" and "código 3" in body["error"]


def test_agent_mode_never_starts_the_runner(tmp_path):
    service = _service(tmp_path, FAKE_OK, mode="agent")
    service.request(ALBUM, SONG)
    assert service.runner._thread is None
    assert service.status(ALBUM, SONG)[1]["status"] == "queued"


def test_runtime_without_stems_addon_leaves_jobs_queued(tmp_path):
    service = _service(tmp_path, FAKE_OK)
    service.engine.check = lambda: {"engineReady": True, "addons": {"stems": {"ready": False}}}
    service.request(ALBUM, SONG)
    assert service.runner._thread is None
    assert service.jobs()["agent"]["online"] is False


def test_local_runner_reports_installed_version_and_refuses_below_floor(tmp_path):
    service = _service(tmp_path, FAKE_OK)
    service.engine.check = lambda: {"version": "0.9.9", "addons": {"stems": {"ready": True}}}
    service.request(ALBUM, SONG)
    _wait(service)
    row = service.queue.worker.helpers()[0]
    assert row['version'] == '0.9.9' and row['versionState'] == 'too-old'
    queued = service.queue.queue.rows(service.queue.kinds)[0]
    assert queued['status'] == 'queued' and queued['attempts'] == 0
