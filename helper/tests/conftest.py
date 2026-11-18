import pytest


@pytest.fixture(autouse=True)
def isolated_worker_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("FLIPSPIN_DATA_DIR", str(tmp_path))
    for key in ("KROBI_DATA_DIR", "KROBI_TOOLS_DIR", "KROBI_MODELS_DIR"):
        monkeypatch.delenv(key, raising=False)
    # Torch is a third-party cache consumer and does not read our root variable.
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "models/torch"))
    monkeypatch.delenv("KROBI_WORKER_ID", raising=False)
