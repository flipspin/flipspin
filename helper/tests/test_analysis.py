"""Analysis protocol, isolation, feature geometry and per-item verdicts."""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from krobi_helper import addons, cli
from krobi_helper.kinds.analysis import model, pipeline, tempo


def test_frontend_geometry_and_silence():
    bands = tempo.features(np.zeros(11025 * 24, dtype=np.float32))
    assert bands.shape == (518, 40)
    assert not bands.any()
    patches = list(tempo.patches(bands))
    assert len(patches) == 3
    assert all(p.shape == (1, 40, 256, 1) and np.isfinite(p).all() for p in patches)
    assert list(tempo.patches(np.zeros((255, 40)))) == []


def test_patch_standardization_and_probability_confidence():
    bands = np.arange(256 * 40, dtype=np.float32).reshape(256, 40)
    patch = next(tempo.patches(bands))
    assert abs(patch.mean()) < 1e-6
    assert abs(patch.std() - 1) < 1e-6
    class Session:
        def run(self, *args):
            p = np.zeros((1, 256), dtype=np.float32)
            p[0, 90], p[0, 91] = .8, .2
            return [p]
    engine = tempo.TempoCNN.__new__(tempo.TempoCNN)
    engine.session, engine.input = Session(), "input"
    assert engine.predict(np.ones(11025 * 24, dtype=np.float32)) == pytest.approx((120, .8))


def test_measurements_and_confidence(monkeypatch):
    samples = np.sin(np.arange(44100 * 12) * .01).astype(np.float32) * .1
    monkeypatch.setattr(pipeline, "decode", lambda _: (samples, {"trackLufs": -24., "truePeak": .1, "lra": 0., "loudnessBlocks": [-24.], "decodeSeconds": .1}))
    monkeypatch.setattr(pipeline, "tempo_audio", lambda _: samples[::4])
    import types
    monkeypatch.setitem(sys.modules, "krobi_keyfinder", types.SimpleNamespace(analyse=lambda *a: (6, [.1]*6+[.9]+[.2]*17)))
    engine = types.SimpleNamespace(predict=lambda _: (120., .7))
    result = pipeline.analyse(Path("song"), engine)
    assert result["key"] == "8B" and result["keyConf"] == pytest.approx(.7)
    assert result["engine"] == "keyfinder+tempocnn" and result["engineVersion"] == 2
    assert set(result) == {"engine", "engineVersion", "key", "keyConf", "bpm", "bpmConf", "energy", "brightness", "pulse", "trackLufs", "truePeak", "lra", "loudnessBlocks", "decodeSeconds"}
    assert 0 <= result["brightness"] <= 1
    assert result["energy"] == pytest.approx(.1 / np.sqrt(2), rel=.001)
    assert all(np.isfinite(v) for v in result.values() if isinstance(v, float))
    assert pipeline.mood_measurements(np.zeros(44100, dtype=np.float32)) == {"energy": 0, "brightness": 0, "pulse": 0}


def test_per_item_failure_continues_and_preserves_signature(monkeypatch):
    items = [{"relPath": f"A/{i}", "audio": str(i), "size": 123, "mtimeNs": 987} for i in range(3)]
    def analyse(path, _):
        if str(path) == "0":
            raise pipeline.DecodeError()
        if str(path) == "1":
            raise ValueError("too-short")
        return {"engine": "keyfinder+tempocnn", "engineVersion": 1, "key": "8B", "keyConf": .2,
                    "bpm": 120., "bpmConf": .8, "energy": .05, "brightness": .25, "pulse": 1.6}
    monkeypatch.setattr(pipeline, "analyse", analyse)
    phases = []
    results = pipeline.run_batch(items, None, lambda phase, progress: phases.append((phase, progress)))
    assert results[:2] == [{"relPath": "A/0", "ok": False, "error": "undecodable", "final": True},
                           {"relPath": "A/1", "ok": False, "error": "too-short", "final": True}]
    assert results[2]["size"] == 123 and results[2]["mtimeNs"] == 987
    assert phases[-1] == ("analizando", 3/25)
    assert pipeline.run_batch(items, None, lambda *a: pytest.fail("stopped"), lambda: True) is None


def test_model_verifies_local_override_before_publishing(monkeypatch, tmp_path):
    import hashlib
    monkeypatch.setenv("KROBI_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.delenv("TORCH_HOME", raising=False)
    source = tmp_path / "source.onnx"
    source.write_bytes(b"onnx")
    monkeypatch.setenv("KROBI_TEMPOCNN_URL", str(source))
    monkeypatch.setattr(model, "SHA256", hashlib.sha256(b"onnx").hexdigest())
    assert cli.cmd_prefetch(argparse.Namespace(addon="analysis")) == 0
    target = addons.model_paths()["tempocnn"]
    assert target.read_bytes() == b"onnx"
    assert "AGPL-3.0" in target.with_suffix(".NOTICE.txt").read_text()
    target.write_bytes(b"corrupt")
    source.write_bytes(b"wrong")
    with pytest.raises(ValueError, match="checksum"):
        model.prefetch()
    assert target.read_bytes() == b"corrupt"
    assert len(list(target.parent.iterdir())) == 2
    addons.remove("analysis")
    assert not target.exists() and not target.with_suffix(".NOTICE.txt").exists()


def test_check_analysis_does_not_require_engine(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("KROBI_MODELS_DIR", str(tmp_path))
    monkeypatch.delenv("TORCH_HOME", raising=False)
    target = addons.model_paths()["tempocnn"]
    target.parent.mkdir(parents=True)
    target.touch()
    monkeypatch.setattr(cli, "_module_ok", lambda m: m in {"onnxruntime", "krobi_keyfinder"})
    assert cli.cmd_check(argparse.Namespace()) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["addons"]["analysis"]["ready"]
    assert "analysis" in result["jobs"] and not result["engineReady"]


@pytest.mark.parametrize("stop", [False, True])
def test_agent_batch_upload_and_stop(monkeypatch, tmp_path, stop):
    from krobi_helper.agent import Agent
    helper = Agent("http://localhost:9", "token", work_dir=tmp_path)
    posts, processes, downloads = [], [], []
    def request(method, path, body=None, **kw):
        posts.append((path, body))
        return {"stop": stop} if path.endswith("/heartbeat") else {"accepted": True}
    monkeypatch.setattr(helper, "_request", request)
    def download(url, target):
        downloads.append(url)
        target.write_bytes(b"audio")
    monkeypatch.setattr(helper, "_download", download)
    items = [{"relPath": f"A/{i}", "size": 3, "mtimeNs": 55, "mediaUrl": f"/api/media/A/{i}"} for i in range(3)]
    results = [{"relPath": i["relPath"], "ok": False, "error": "undecodable", "final": True} for i in items]
    def run(argv, report, flag):
        processes.append(argv)
        spec = json.loads(Path(argv[argv.index("--jobs")+1]).read_text())
        assert len(spec) == 3 and all(Path(i["audio"]).is_file() for i in spec)
        return {"event": "done", "items": results}
    monkeypatch.setattr(helper, "_run_process", run)
    helper._process_analysis({"id": "batch", "lease": "lease", "items": items})
    uploaded = [body for path, body in posts if path.endswith("/result")]
    if stop:
        assert not processes and not downloads and not uploaded
    else:
        assert len(processes) == 1
        assert uploaded == [{"lease": "lease", "items": results}]
    assert not list(tmp_path.glob("analysis-*"))


def test_tempocnn_never_requests_gpu_providers(monkeypatch, tmp_path):
    from types import SimpleNamespace
    calls = []
    def session(path, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(get_inputs=lambda: [SimpleNamespace(name="input")])
    monkeypatch.setitem(sys.modules, "onnxruntime", SimpleNamespace(SessionOptions=SimpleNamespace, InferenceSession=session))
    monkeypatch.setenv("KROBI_ACCEL", "cuda")
    tempo.TempoCNN(tmp_path / "model.onnx")
    assert calls[0]["providers"] == ["CPUExecutionProvider"]


@pytest.mark.parametrize('channels', [1, 2])
def test_real_ebur128_retains_original_channels_and_decodes_once(tmp_path, channels):
    import subprocess
    path = tmp_path / 'tone.wav'
    # Opposite phase stereo cancels in the mono key/tempo branch, but remains loud.
    signal = '0.125*sin(2*PI*1000*t)' + ('|-0.125*sin(2*PI*1000*t)' if channels == 2 else '')
    subprocess.run([pipeline.ffmpeg(), '-v', 'error', '-f', 'lavfi', '-i',
                    f'aevalsrc={signal}:s=48000:d=2', str(path)], check=True)
    samples, loudness = pipeline.decode(path)
    assert len(samples) == pipeline.RATE * 2
    assert loudness['trackLufs'] == pytest.approx(-21.07 + (3.01 if channels == 2 else 0), abs=.1)
    assert loudness['truePeak'] == pytest.approx(.125, abs=.001)
    assert loudness['lra'] == 0 and loudness['decodeSeconds'] > 0
    assert len(loudness['loudnessBlocks']) >= 16
    if channels == 2:
        assert abs(samples).max() < 1e-6
    # Short songs still get loudness even though the tempo model needs 12 seconds.
    result = pipeline.analyse(path, None)
    assert result['key'] is result['bpm'] is None
    assert result['trackLufs'] == loudness['trackLufs']


def test_real_ebur128_silence_is_finite_and_never_gets_a_boost(tmp_path):
    import subprocess
    path = tmp_path / 'silence.wav'
    subprocess.run([pipeline.ffmpeg(), '-v', 'error', '-f', 'lavfi', '-i',
                    'anullsrc=r=44100:cl=stereo', '-t', '1', str(path)], check=True)
    _, loudness = pipeline.decode(path)
    assert loudness['trackLufs'] is None and loudness['truePeak'] == 0
    assert loudness['loudnessBlocks'] == []


def test_true_peak_detects_intersample_peak_and_retains_early_maximum(tmp_path):
    import subprocess
    path = tmp_path / 'peak.wav'
    subprocess.run([pipeline.ffmpeg(), '-v', 'error', '-f', 'lavfi', '-i',
                    'aevalsrc=if(lt(t\\,1)\\,0.9\\,0.01)*sin(2*PI*11025*t+PI/4):s=44100:d=2',
                    '-c:a', 'pcm_f32le', str(path)], check=True)
    samples, measured = pipeline.decode(path)
    assert abs(samples).max() < .65
    assert measured['truePeak'] > .85
