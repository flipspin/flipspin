"""Existing helper identity and live lock must survive the directory rename."""
from krobi_helper.agent import lock_path
from krobi_helper.mac_facts import stable_id, tools_dir


def test_legacy_identity_and_lock_share_the_same_files(tmp_path, monkeypatch):
    root = tmp_path / "tools"
    legacy = root / "lyrics"
    legacy.mkdir(parents=True)
    identity = "c385cb4e-1f87-4cbd-ae1d-5d82c932ed3e"
    (legacy / "worker-id").write_text(identity)
    (legacy / "agent.lock").write_text("12345")
    monkeypatch.setenv("KROBI_TOOLS_DIR", str(root))
    assert tools_dir() == root / "helper"
    assert stable_id() == identity
    assert lock_path().samefile(legacy / "agent.lock")
    assert tools_dir().samefile(legacy)
    assert tools_dir() == root / "helper"  # migration is idempotent
