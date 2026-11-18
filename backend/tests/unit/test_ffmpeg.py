"""ffmpeg order, provenance, validation and cached version probing."""
import subprocess
from unittest.mock import Mock

import pytest

from app.infra import ffmpeg
from app.exceptions import ConfigurationError


@pytest.fixture
def selection(monkeypatch):
    monkeypatch.delenv("KROBI_FFMPEG_PATH", raising=False)
    monkeypatch.setattr(ffmpeg.sys, "platform", "linux")
    monkeypatch.setattr(ffmpeg.shutil, "which", lambda _: "/system/ffmpeg")
    monkeypatch.setattr(ffmpeg, "bundled_ffmpeg_path", lambda: "/bundled/ffmpeg")
    versions = {"/override/ffmpeg": "8.0", "/system/ffmpeg": "7.2", "/bundled/ffmpeg": "7.1"}
    calls = []
    def version(path):
        calls.append(path)
        if path not in versions:
            raise ValueError("not runnable")
        return versions[path]
    monkeypatch.setattr(ffmpeg, "_cached_version", version)
    return versions, calls


@pytest.mark.parametrize("override,system,expected,source", [
    ("/override/ffmpeg", True, "/override/ffmpeg", "env"),
    ("/broken/ffmpeg", True, "/system/ffmpeg", "system"),
    (None, True, "/system/ffmpeg", "system"),
    (None, False, "/bundled/ffmpeg", "bundled"),
    ("/broken/ffmpeg", False, "/bundled/ffmpeg", "bundled"),
])
def test_resolution_order(selection, monkeypatch, override, system, expected, source):
    versions, calls = selection
    if override:
        monkeypatch.setenv("KROBI_FFMPEG_PATH", override)
    if not system:
        versions.pop("/system/ffmpeg")
    info = ffmpeg.resolve_ffmpeg_info()
    assert (info.path, info.source, info.version) == (expected, source, versions[expected])
    assert ffmpeg.resolve_ffmpeg() == expected
    if source == "env":
        assert "/system/ffmpeg" not in calls and "/bundled/ffmpeg" not in calls


@pytest.mark.parametrize("directory", ["/opt/homebrew/bin", "/usr/local/bin"])
def test_mac_gui_without_path_uses_installed_ffmpeg(selection, monkeypatch, directory):
    versions, _ = selection
    monkeypatch.setattr(ffmpeg.sys, "platform", "darwin")
    monkeypatch.setattr(ffmpeg.shutil, "which", lambda _: None)
    versions[f"{directory}/ffmpeg"] = "8.0"
    assert ffmpeg.resolve_ffmpeg_info() == ffmpeg.FFmpeg(f"{directory}/ffmpeg", "8.0", "system")


def test_no_runnable_binary_is_a_configuration_error(selection):
    versions, _ = selection
    versions.clear()
    with pytest.raises(ConfigurationError):
        ffmpeg.resolve_ffmpeg()


def test_version_is_probed_only_once_per_path(tmp_path, monkeypatch):
    binary = tmp_path / "ffmpeg"
    binary.touch()
    run = Mock(return_value=subprocess.CompletedProcess([], 0, "ffmpeg version 7.1 Copyright\n"))
    monkeypatch.setattr(ffmpeg.subprocess, "run", run)
    ffmpeg._cached_version.cache_clear()
    try:
        assert ffmpeg._cached_version(str(binary)) == "7.1"
        assert ffmpeg._cached_version(str(binary)) == "7.1"
        run.assert_called_once()
    finally:
        ffmpeg._cached_version.cache_clear()


@pytest.mark.parametrize("failure", ["missing", "permission", "exit", "timeout", "other-program"])
def test_probe_rejects_unusable_paths(tmp_path, monkeypatch, failure):
    binary = tmp_path / "ffmpeg"
    if failure != "missing":
        binary.touch()
    effects = {"permission": PermissionError(), "exit": subprocess.CalledProcessError(1, []),
               "timeout": subprocess.TimeoutExpired([], 5)}
    monkeypatch.setattr(ffmpeg.subprocess, "run", Mock(side_effect=effects.get(failure),
                        return_value=subprocess.CompletedProcess([], 0, "another program\n")))
    with pytest.raises(ValueError):
        ffmpeg.probe_ffmpeg(str(binary))


def test_frozen_fallback_is_beside_backend_not_on_path(monkeypatch):
    monkeypatch.setattr(ffmpeg.sys, "frozen", True, raising=False)
    monkeypatch.setattr(ffmpeg.sys, "executable", "/resources/backend/krobi-backend")
    monkeypatch.setattr(ffmpeg.sys, "platform", "linux")
    assert ffmpeg.bundled_ffmpeg_path() == "/resources/backend/ffmpeg/ffmpeg"


def test_imageio_override_does_not_replace_bundled_binary(monkeypatch):
    monkeypatch.setenv("IMAGEIO_FFMPEG_EXE", "/other/ffmpeg")
    monkeypatch.setattr(ffmpeg.sys, "frozen", False, raising=False)
    assert "/imageio_ffmpeg/binaries/ffmpeg-" in ffmpeg.bundled_ffmpeg_path()
