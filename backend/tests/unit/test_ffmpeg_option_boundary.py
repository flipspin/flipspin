"""User-derived local output names are operands, including shell metacharacters."""
from types import SimpleNamespace
from app.infra import demo_overrides


def test_trim_output_is_after_options(tmp_path, monkeypatch):
    path = tmp_path / 'song & literal | title.mp3'
    path.write_bytes(b'original')
    def run(cmd, **kwargs):
        assert cmd[cmd.index('-c:a') + 1] == 'copy'
        assert cmd[-2:] == ['--', str(path.with_name('.trim-' + path.name))]
        path.with_name('.trim-' + path.name).write_bytes(b'trimmed')
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(demo_overrides.subprocess, 'run', run)
    assert demo_overrides.trim_head(path, 1)
    assert path.read_bytes() == b'trimmed'
