"""Model selection, shared ownership and verified failover, without ML imports."""
import argparse
import hashlib
import io
from importlib import metadata
from pathlib import Path
from types import SimpleNamespace

import pytest
from krobi_helper import addons, cli
from krobi_helper.kinds.lyrics import align as downloads


@pytest.fixture
def models(monkeypatch, tmp_path):
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "torch"))
    monkeypatch.setenv("KROBI_ACCEL", "cpu")
    return addons.model_paths()


@pytest.mark.parametrize("addon,expected", [("lyrics", ["aligner", "demucs"]), ("stems", ["demucs", "beats"])])
def test_prefetch_only_selected_models(monkeypatch, models, addon, expected):
    calls = []
    def fetch(name):
        calls.append(name)
        models[name].parent.mkdir(parents=True, exist_ok=True)
        models[name].write_bytes(name.encode())
    for name, function in (("aligner", "_prefetch_aligner"), ("demucs", "_prefetch_demucs"), ("beats", "_prefetch_beats")):
        monkeypatch.setattr(cli, function, lambda name=name: fetch(name))
    monkeypatch.setattr(cli, "_prefetch_whisper", lambda: pytest.fail("Whisper must stay dormant"))
    assert cli.cmd_prefetch(argparse.Namespace(addon=addon)) == 0
    assert calls == expected
    assert addons.status()[addon]["ready"]
    other = "stems" if addon == "lyrics" else "lyrics"
    assert not addons.status()[other]["installed"]


@pytest.mark.parametrize("first", ["lyrics", "stems"])
def test_removal_retains_shared_model_until_last_owner(models, first):
    for path in models.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"model")
    addons.save_selections({"lyrics": True, "stems": True})
    addons.remove(first)
    other = "lyrics" if first == "stems" else "stems"
    assert models["demucs"].exists()
    assert addons.status()[other]["ready"]
    assert not addons.status()[first]["installed"]
    addons.remove(other)
    assert not any(models[name].exists() for name in ("aligner", "demucs", "beats"))
    assert models["tempocnn"].exists()  # independent adopted analysis add-on


def test_separator_reuses_existing_model(monkeypatch, models):
    models["demucs"].parent.mkdir(parents=True)
    models["demucs"].write_bytes(b"cached")
    # An ML import would fail in this test environment.
    cli._prefetch_demucs()


def test_fallback_verifies_before_publishing(monkeypatch, models):
    payload = b"the original checkpoint"
    monkeypatch.setattr(downloads, "MMS_SHA256", hashlib.sha256(payload).hexdigest())
    calls = []
    def download(url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            raise OSError("CERTIFICATE_VERIFY_FAILED")
        assert not models["aligner"].exists()
        return io.BytesIO(payload)
    monkeypatch.setattr(downloads, "urlopen", download)
    assert downloads.ensure_aligner().read_bytes() == payload
    assert calls == list(downloads.MMS_URLS)
    # A verified cache works offline without another request.
    assert downloads.ensure_aligner().read_bytes() == payload
    assert len(calls) == 2


def test_mismatched_mirror_is_never_published(monkeypatch, models):
    models["aligner"].parent.mkdir(parents=True)
    models["aligner"].write_bytes(b"corrupt cached checkpoint")
    monkeypatch.setattr(downloads, "urlopen", lambda *a, **kw: io.BytesIO(b"wrong checkpoint"))
    with pytest.raises(RuntimeError, match="SHA-256 mismatch"):
        downloads.ensure_aligner()
    assert not models["aligner"].exists()
    assert list(models["aligner"].parent.iterdir()) == []


def test_failed_prefetch_stays_repairable_and_removable(monkeypatch, models):
    def fail():
        raise OSError("disk full")
    monkeypatch.setattr(cli, "_prefetch_aligner", fail)
    assert cli.cmd_prefetch(argparse.Namespace(addon="lyrics")) == 1
    assert addons.status()["lyrics"]["installed"]
    assert not addons.status()["lyrics"]["ready"]
    assert not addons.status()["stems"]["installed"]
    addons.remove("lyrics")
    assert not addons.status()["lyrics"]["installed"]


def test_measured_sizes_separate_shared_models_and_analysis_runtime(monkeypatch, models, tmp_path):
    for name, path in models.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(name.encode())
    addons.save_selections({name: True for name in addons.REQUIRES})
    packages = {
        "onnxruntime": (["onnxruntime/runtime.so", "shared.py"], ["numpy>=1", "flatbuffers", "unused; python_version < '3'", "extra; extra == 'gpu'"]),
        "krobi-keyfinder": (["keyfinder/native.dylib", "shared.py"], []),
        "numpy": (["numpy/native.so"], []),
        "krobi-helper": (["helper.py"], ["numpy", "torch; extra == 'engine'", "onnxruntime; extra == 'analysis'"]),
        "torch": (["torch/native.so"], ["sympy"]),
        "sympy": (["sympy/runtime.py"], []),
        "flatbuffers": (["flatbuffers/runtime.py"], ["onnxruntime"]),  # cycle
    }
    files = {file for paths, _ in packages.values() for file in paths}
    for file in files:
        path = tmp_path / file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(file.encode())

    # ONNX Runtime also uses sympy, which belongs to the shared engine runtime.
    packages["onnxruntime"][1].append("sympy")

    def distribution(name):
        paths, requires = packages[name]
        return SimpleNamespace(files=[Path(p) for p in paths], requires=requires, locate_file=lambda p: tmp_path / p)

    monkeypatch.setattr(addons.metadata, "distribution", distribution)
    status = addons.status()
    assert status["lyrics"]["sizeBytes"] == len(b"aligner")
    assert status["stems"]["sizeBytes"] == len(b"beats")
    assert status["lyrics"]["sharedBytes"] == status["stems"]["sharedBytes"] == len(b"demucs")
    own_files = files - {"numpy/native.so", "helper.py", "torch/native.so", "sympy/runtime.py"}
    assert status["analysis"]["runtimeBytes"] == sum(len(file.encode()) for file in own_files)
    assert status["analysis"]["sizeBytes"] == len(b"tempocnn") + status["analysis"]["runtimeBytes"]
    addons.remove("lyrics")
    assert addons.status()["lyrics"]["sizeBytes"] is None
    assert addons.status()["stems"]["sizeBytes"] == len(b"beats")
    assert addons.status()["stems"]["sharedBytes"] == len(b"demucs")
    addons.remove("analysis")
    assert addons.status()["analysis"]["sizeBytes"] is None
    assert addons.status()["analysis"]["runtimeBytes"] == status["analysis"]["runtimeBytes"]


def test_analysis_size_tolerates_missing_packages_and_files(monkeypatch, models):
    models["tempocnn"].parent.mkdir(parents=True)
    models["tempocnn"].write_bytes(b"tempo")
    addons.save_selections({"analysis": True})

    def distribution(name):
        if name == "numpy":
            return SimpleNamespace(files=[Path("missing.so")], requires=[], locate_file=lambda p: models["tempocnn"].parent / p)
        raise metadata.PackageNotFoundError(name)

    monkeypatch.setattr(addons.metadata, "distribution", distribution)
    assert addons.status()["analysis"]["sizeBytes"] == 5
    addons.remove("analysis")
    assert addons.status()["analysis"]["sizeBytes"] is None


def test_missing_shared_model_has_no_measured_size(models):
    addons.save_selections({"lyrics": True, "stems": True})
    status = addons.status()
    assert status["lyrics"]["sizeBytes"] == status["stems"]["sizeBytes"] == 0
    assert status["lyrics"]["sharedBytes"] is status["stems"]["sharedBytes"] is None
    assert not status["lyrics"]["ready"] and not status["stems"]["ready"]
