"""Backend selection and fast capability reporting without model imports."""
import argparse
import builtins
import json
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from krobi_helper import acceleration as A, cli, pipeline, stems


@pytest.fixture(autouse=True)
def clean_override(monkeypatch):
    monkeypatch.delenv("KROBI_ACCEL", raising=False)


def test_cpu_override_never_loads_torch_or_mlx(monkeypatch):
    monkeypatch.setenv("KROBI_ACCEL", "cpu")
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert name.split(".")[0] not in {"torch", "mlx", "mlx_whisper", "demucs_mlx"}
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded)
    assert A.detect() == {"accel": "cpu", "gpu": None}
    assert A.torch_device() == "cpu"


def test_apple_silicon_stays_mlx(monkeypatch):
    monkeypatch.setattr(A.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(A.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(A, "hardware", lambda: {"chip": "Apple M1 Pro"})
    assert A.detect() == {"accel": "mlx", "gpu": "Apple M1 Pro"}
    assert A.torch_device() == "mps"


@pytest.mark.parametrize("available", [False, True])
def test_cuda_uses_torch_availability_and_gpu_name(monkeypatch, available):
    monkeypatch.setattr(A.platform, "system", lambda: "Linux")
    monkeypatch.setattr(A, "module_ok", lambda _: True)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=SimpleNamespace(
        is_available=lambda: available, get_device_name=lambda: "NVIDIA test GPU")))
    assert A.detect() == {"accel": "cuda" if available else "cpu", "gpu": "NVIDIA test GPU" if available else None}


def test_check_reports_installed_jobs_with_no_heavy_imports(monkeypatch, capsys):
    monkeypatch.setenv("KROBI_ACCEL", "cpu")
    monkeypatch.setattr(A, "supported", lambda: True)
    monkeypatch.setattr(A, "module_ok", lambda _: True)
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert name.split(".")[0] not in {"torch", "torchaudio", "whisper", "mlx", "demucs", "beat_this"}
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded)
    assert cli.cmd_check(argparse.Namespace()) == 0
    status = json.loads(capsys.readouterr().out)
    assert status["accel"] == "cpu" and status["gpu"] is None
    assert "transcribe" not in status["jobs"]
    assert status["engineReady"]
    assert all(key in status for key in ("os", "chip", "memoryBytes"))


def test_check_default_never_imports_torch(monkeypatch, capsys):
    monkeypatch.setattr(A.platform, "system", lambda: "Linux")
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert name.split(".")[0] not in {"torch", "mlx", "whisper", "demucs"}
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded)
    cli.cmd_check(argparse.Namespace())
    assert json.loads(capsys.readouterr().out)["accel"] in {"cpu", "cuda"}


def test_jobs_exclude_missing_transcriber_and_separator(monkeypatch):
    monkeypatch.setenv("KROBI_ACCEL", "cpu")
    monkeypatch.setattr(A, "supported", lambda: True)
    monkeypatch.setattr(A, "module_ok", lambda name: name != "whisper")
    assert A.capabilities(lightweight=True)["jobs"] == ["align", "stems"]
    monkeypatch.setattr(A, "module_ok", lambda name: name != "demucs")
    assert A.capabilities(lightweight=True)["jobs"] == []


def test_portable_transcribe_same_model_and_options(monkeypatch, tmp_path):
    monkeypatch.setenv("KROBI_ACCEL", "cpu")
    result = {"language": "es", "segments": []}
    model = SimpleNamespace(transcribe=Mock(return_value=result))
    load = Mock(return_value=model)
    monkeypatch.setitem(sys.modules, "whisper", SimpleNamespace(load_model=load))
    assert pipeline.transcribe(tmp_path / "voice.wav", "es") == result
    assert load.call_args.args == ("large-v3-turbo",)
    assert load.call_args.kwargs["device"] == "cpu"
    assert model.transcribe.call_args.kwargs == dict(language="es", word_timestamps=True,
                                                      condition_on_previous_text=False, fp16=False)


def test_mlx_transcribe_options_unchanged(monkeypatch, tmp_path):
    monkeypatch.setattr(A, "detect", lambda **_: {"accel": "mlx"})
    transcribe = Mock(return_value={})
    monkeypatch.setitem(sys.modules, "mlx_whisper", SimpleNamespace(transcribe=transcribe))
    pipeline.transcribe(tmp_path / "voice.wav", "es")
    assert transcribe.call_args.kwargs == dict(language="es", word_timestamps=True,
        condition_on_previous_text=False, path_or_hf_repo="mlx-community/whisper-large-v3-turbo")


def test_stems_cpu_dispatch_and_beats_never_use_mps(monkeypatch, tmp_path):
    from krobi_helper import separation

    monkeypatch.setenv("KROBI_ACCEL", "cpu")
    split = Mock(return_value=({}, 44100))
    monkeypatch.setattr(separation, "separate", split)
    assert stems.separate(tmp_path / "mix.wav", "htdemucs") == ({}, 44100)
    tracker = Mock(return_value=([1, 2], [1]))
    factory = Mock(return_value=tracker)
    monkeypatch.setitem(sys.modules, "beat_this", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "beat_this.inference", SimpleNamespace(Audio2Beats=factory))
    assert stems.detect_beats(None, 44100) == ([1.0, 2.0], [1.0])
    assert factory.call_args.kwargs["device"] == "cpu"


def test_hidden_accel_flag_propagates_to_children(monkeypatch):
    monkeypatch.setattr(cli, "cmd_check", lambda _: 0)
    assert cli.main(["check", "--accel", "cpu"]) == 0
    assert A.detect()["accel"] == "cpu"


def test_agent_claim_and_heartbeat_identity_has_capabilities(monkeypatch, tmp_path):
    from krobi_helper import agent

    facts = dict(os="linux", accel="cuda", gpu="NVIDIA test GPU", chip="Test CPU", memoryBytes=16 << 30,
                 jobs=["align", "transcribe", "stems"])
    monkeypatch.setattr(agent, "capabilities", lambda **kw: facts)
    helper = agent.Agent("http://localhost:9", "t", work_dir=tmp_path)
    for state in ("idle", "working"):
        assert all(helper.identity(state)[key] == value for key, value in facts.items())


def test_fast_cuda_reads_metadata_and_visible_device_name_without_torch(monkeypatch, tmp_path):
    import ctypes

    root = tmp_path / 'torch'
    (root / 'lib').mkdir(parents=True)
    (root / 'version.py').write_text('cuda: str = "12.6"\n')
    (root / 'lib' / 'libcudart.so').touch()
    monkeypatch.setattr(A, 'module_ok', lambda _: True)
    monkeypatch.setattr(A.importlib.util, 'find_spec', lambda _: SimpleNamespace(origin=str(root / '__init__.py')))
    monkeypatch.setattr(A.ctypes.util, 'find_library', lambda _: None)
    class Runtime:
        def cudaGetDeviceCount(self, count):
            count._obj.value = 1
            return 0
        def cudaGetDeviceProperties(self, props, device):
            assert device == 0
            ctypes.memmove(props, b'NVIDIA visible GPU\0', 19)
            return 0
    monkeypatch.setattr(A.ctypes, 'CDLL', lambda _: Runtime())
    assert A._fast_cuda() == (True, 'NVIDIA visible GPU')
    (root / 'version.py').write_text('cuda = None\n')
    assert A._fast_cuda() == (False, None)


def test_mlx_stems_preserves_batch_size_one(monkeypatch, tmp_path):
    import numpy as np

    monkeypatch.setattr(A, 'detect', lambda **_: {'accel': 'mlx'})
    separator = SimpleNamespace(samplerate=44100,
        separate_audio_file=lambda _: (None, {name: np.zeros((2, 100)) for name in stems.STEMS}))
    factory = Mock(return_value=separator)
    monkeypatch.setitem(sys.modules, 'demucs_mlx', SimpleNamespace(Separator=factory))
    sources, sr = stems.separate(tmp_path / 'song.wav', 'htdemucs')
    assert sr == 44100 and sources['vocals'].shape == (100, 2)
    factory.assert_called_once_with(model='htdemucs', batch_size=1)


def test_mlx_lyrics_preserves_batch_size_one(monkeypatch, tmp_path):
    import numpy as np
    from krobi_helper import protocol as P

    calls = []

    class Separator:
        samplerate = 44100

        def __init__(self, **kwargs):
            calls.append(kwargs)

        def separate_audio_file(self, path):
            assert path == str(tmp_path / 'mix44.wav')
            return None, {'vocals': np.zeros((2, 100))}

    monkeypatch.setattr(A, 'detect', lambda **_: {'accel': 'mlx'})
    monkeypatch.setitem(sys.modules, 'demucs_mlx', SimpleNamespace(Separator=Separator))
    write = Mock()
    monkeypatch.setitem(sys.modules, 'soundfile', SimpleNamespace(write=write))
    monkeypatch.setattr(pipeline, 'ffmpeg_binary', lambda: 'ffmpeg')
    monkeypatch.setattr(pipeline.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0))

    assert pipeline.isolate_vocals(tmp_path / 'mix44.wav', tmp_path) == tmp_path / 'vocals16.wav'
    assert calls == [{'model': P.DEMUCS_MODEL, 'batch_size': 1}]
    assert write.call_args.args[1].shape == (100, 2)
    assert write.call_args.args[2] == 44100
