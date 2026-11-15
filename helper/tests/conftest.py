import pytest


@pytest.fixture(autouse=True)
def isolated_worker_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("KROBI_TOOLS_DIR", str(tmp_path / "tools"))
    monkeypatch.setenv("KROBI_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "models/torch"))
    monkeypatch.delenv("KROBI_WORKER_ID", raising=False)
