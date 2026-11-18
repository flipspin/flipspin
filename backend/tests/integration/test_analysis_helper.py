"""Opt-in real-model helper round trip against an isolated local HTTP backend.

Set KROBI_ANALYSIS_TEST_PYTHON to a clean analysis-extra interpreter,
KROBI_ANALYSIS_TEST_MODEL to the exported ONNX, and KROBI_ANALYSIS_TEST_AUDIO
to a directory containing at least three decodable MP3 clips (>12 seconds).
"""
from ipaddress import IPv4Address
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient

from app.dependencies import DependencyContainer
from app.main import app


@pytest.mark.skipif(not os.environ.get("KROBI_ANALYSIS_TEST_PYTHON"), reason="real analysis artifacts are opt-in")
def test_three_songs_through_real_agent_http_and_sqlite(config, monkeypatch, tmp_path):
    config.lyrics_engine_mode = "agent"
    container = DependencyContainer(config)
    monkeypatch.setattr(app.state, "container", container)
    monkeypatch.setattr(app.state, "config", config)
    _, owner_token = container.get_token_store().mint("Owner", "owner")
    owner = TestClient(app, headers={"Authorization": f"Bearer {owner_token}"})
    enrolled = owner.post("/api/me/devices", json={"label": "Analysis test", "helper": True})
    assert enrolled.status_code == 201, enrolled.text
    token = enrolled.json()["token"]
    tracks = []
    album = config.base_music_dir / "Album"
    album.mkdir()
    for index, clip in enumerate(sorted(Path(os.environ["KROBI_ANALYSIS_TEST_AUDIO"]).glob("*.mp3"))[:3]):
        target = album / f"song-{index}.mp3"
        shutil.copyfile(clip, target)
        tracks.append(target)
    assert len(tracks) == 3
    analysis = container.get_analysis_service()
    assert analysis.enqueue_files(tracks) == 3
    models = tmp_path / "models"
    (models / "tempocnn").mkdir(parents=True)
    shutil.copyfile(os.environ["KROBI_ANALYSIS_TEST_MODEL"], models / "tempocnn/deeptemp-k16-3.onnx")
    (models / "addons.json").write_text(json.dumps({"analysis": True}))
    listener = socket.socket()
    loopback = str(IPv4Address(socket.INADDR_LOOPBACK))
    listener.bind((loopback, 0))
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="error"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    try:
        while not server.started and time.monotonic() < deadline:
            time.sleep(.01)
        assert server.started
        env = {**os.environ, "KROBI_API_TOKEN": token, "KROBI_MODELS_DIR": str(models),
               "TORCH_HOME": str(models / "torch"), "HF_HOME": str(models / "hf"),
               "KROBI_TOOLS_DIR": str(tmp_path / "tools"), "KROBI_ACCEL": "cpu",
               "KROBI_FFMPEG_PATH": config.ffmpeg_path, "OMP_NUM_THREADS": "1"}
        result = subprocess.run([os.environ["KROBI_ANALYSIS_TEST_PYTHON"], "-m", "krobi_helper.cli", "agent",
                                 "--server", f"http://{loopback}:{listener.getsockname()[1]}", "--once"],
                                env=env, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stderr
        with sqlite3.connect(config.analysis_db) as database:
            rows = database.execute("SELECT rel_path, key, key_conf, bpm, bpm_conf FROM track_analysis").fetchall()
        assert len(rows) == 3, (rows, result.stderr)
        assert all(key and 0 <= key_conf <= 1 and 30 <= bpm <= 300 and 0 <= bpm_conf <= 1
                   for _, key, key_conf, bpm, bpm_conf in rows)
        print("HTTP agent -> analysis.sqlite:", json.dumps(rows))
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
        analysis.stop()
        container.get_jobs().close()
