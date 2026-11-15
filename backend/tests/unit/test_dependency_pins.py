"""pyproject.toml names the dependencies; the requirements files pin them.

``[project.dependencies]`` says *which* packages the server needs.
``requirements-runtime.txt`` (servers, Docker) and ``requirements.txt``
(dev, CI, PyInstaller) say *which exact versions* were tested. A package added
to one side and forgotten on the other installs fine on the machine that added
it and fails on the next one, so the two are checked against each other here.
"""
import re
import tomllib
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]


def _name(requirement: str) -> str:
    return re.split(r"[<>=!~\[; ]", requirement.strip(), maxsplit=1)[0].lower().replace("_", "-")


def _pinned(path: Path) -> set[str]:
    names = set()
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line.startswith("-r "):
            names.update(_pinned(path.parent / line[3:].strip()))
        elif line:
            names.add(_name(line))
    return names


PROJECT = tomllib.loads((BACKEND / "pyproject.toml").read_text())["project"]
RUNTIME = {_name(r) for r in PROJECT["dependencies"]}
DEV = {_name(r) for r in PROJECT["optional-dependencies"]["dev"]}


def test_every_runtime_dependency_is_pinned_for_servers():
    missing = RUNTIME - _pinned(BACKEND / "requirements-runtime.txt")
    assert not missing, f"add pins to requirements-runtime.txt: {sorted(missing)}"


def test_every_dependency_is_pinned_for_development():
    missing = (RUNTIME | DEV) - _pinned(BACKEND / "requirements.txt")
    assert not missing, f"add pins to requirements.txt: {sorted(missing)}"


def test_no_dev_tool_ships_to_servers():
    leaked = DEV & _pinned(BACKEND / "requirements-runtime.txt")
    assert not leaked, f"dev-only packages in requirements-runtime.txt: {sorted(leaked)}"


def test_container_dependencies_match_runtime_without_bundled_ffmpeg():
    assert _pinned(BACKEND / "requirements-server.txt") == (
        _pinned(BACKEND / "requirements-runtime.txt") - {"imageio-ffmpeg"}
    )


@pytest.mark.parametrize("path", sorted(BACKEND.glob("requirements*.txt")), ids=lambda path: path.name)
def test_check_9_no_analysis_engines_in_server_requirements(path):
    forbidden = {
        "librosa", "scipy", "numba", "llvmlite", "scikit-learn", "sklearn",
        "essentia", "madmom", "onnxruntime", "krobi-keyfinder",
        "audioread", "resampy", "soundfile",
    }
    leaked = forbidden & _pinned(path)
    assert not leaked, f"analysis dependencies in {path.name}: {sorted(leaked)}"
