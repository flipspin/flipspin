#!/usr/bin/env python3
"""Disposable clean-install QA. Requires only Python 3 + local Docker; never pushes.

make qa-install [QA_PLATFORM=linux/amd64]
python3 scripts/qa/install.py --platform linux/arm64 [--builder NAME]
"""

import argparse
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SONG = "Test Artist/Test Album/01 Canción.mp3"
NAME = "QA Nest — Canción"
LABEL = "QA Owner"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class InstallQA:
    def __init__(self, args):
        self.args = args
        self.container = "krobi-qa-" + uuid.uuid4().hex[:12]
        self.temp = Path(tempfile.mkdtemp(prefix="krobi-qa-")).resolve()
        self.music = self.temp / "music"
        self.data = self.temp / "data"
        self.music.mkdir()
        self.data.mkdir()
        self.token = None
        self.base = None
        # Never send requests or bearer tokens through a developer's HTTP proxy.
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def docker(self, *args, capture=True, input=None):
        return subprocess.run(
            ["docker", *args], cwd=ROOT, check=True, text=True, input=input,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        ).stdout

    def inside(self, source, *args):
        return self.docker("exec", "-i", self.container, "python", "-", *args, input=source)

    def request(self, path, expected=200, body=None, headers=None):
        request_headers = {"Authorization": "Bearer " + self.token} if self.token else {}
        request_headers.update(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=request_headers)
        try:
            response = self.http.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            content = response.read()
            require(response.status == expected,
                    f"{request.get_method()} {path}: HTTP {response.status}, expected {expected}")
            return content, response.headers

    def get_json(self, path):
        return json.loads(self.request(path)[0])

    def wait_healthy(self):
        deadline = time.monotonic() + 90
        last = "no response"
        while time.monotonic() < deadline:
            try:
                health = self.get_json("/api/health")
                require(health.get("status") == "ok", "health status is not ok")
                require(health.get("ffmpeg_available") is True, "ffmpeg unavailable")
                state = json.loads(self.docker("inspect", self.container))[0]["State"]
                require(state.get("Health", {}).get("Status") == "healthy", "Docker health not healthy")
                return
            except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
                last = str(error)
                time.sleep(1)
        raise RuntimeError(f"health timeout (90s): {last}")

    def build(self):
        require(os.getuid() != 0, "invoke QA as a non-root user to test non-root PUID")
        require(shutil.which("docker"), "docker is not installed")
        args = ["build", "--load", "-f", "backend/Dockerfile", "-t", "krobi:qa"]
        if self.args.platform:
            args += ["--platform", self.args.platform]
        if self.args.builder:
            args += ["--builder", self.args.builder]
        self.docker(*args, ".", capture=False)
        # A clean runtime ships no audio source code.
        self.docker("run", "--rm", "--entrypoint", "python", "krobi:qa", "-c", """
from pathlib import Path
from app.infra.extensions import source_extensions
assert source_extensions(Path('/tmp/empty-nest')) == []
""")
        info = json.loads(self.docker("image", "inspect", "krobi:qa"))[0]
        print(f"IMAGE {info['Os']}/{info['Architecture']} inspect.Size={info['Size']} bytes", flush=True)
        # Newer containerd stores report compressed Size in inspect; this command
        # also shows local storage/unpacked size alongside shared layers.
        for line in self.docker("system", "df", "-v").splitlines():
            if line.split()[:2] == ["krobi", "qa"]:
                print("IMAGE local storage: " + line, flush=True)

    def boot(self):
        require(not list(self.music.iterdir()) and not list(self.data.iterdir()), "mounts must start empty")
        args = ["run", "-d", "--name", self.container,
                "-p", "127.0.0.1::8000", "-e", f"PUID={os.getuid()}", "-e", f"PGID={os.getgid()}",
                "--mount", f"type=bind,src={self.music},dst=/music",
                "--mount", f"type=bind,src={self.data},dst=/data"]
        if self.args.platform:
            args += ["--platform", self.args.platform]
        self.docker(*args, "krobi:qa")
        self.update_base()
        self.wait_healthy()

    def update_base(self):
        # Docker may reassign an automatically allocated host port on restart.
        info = json.loads(self.docker("inspect", self.container))[0]
        port = info["NetworkSettings"]["Ports"]["8000/tcp"][0]["HostPort"]
        self.base = "http://127.0.0.1:" + port

    def unclaimed_status(self):
        status = self.get_json("/api/status")
        require(status.get("isInit") is False, "fresh server is already initialized")
        require(status.get("setupTokenRequired") is True, "setup token not required")
        require(bool(status.get("dataDir")), "dataDir missing before claim")
        setup_path = self.data / "Krobi/setup-token"
        code = setup_path.read_text().strip()
        require(bool(code) and code not in json.dumps(status), "setup code missing or leaked in status")
        require(stat.S_IMODE(setup_path.stat().st_mode) == 0o600, "setup-token mode is not 0600")
        logs = self.container_logs()
        self.setup_banner_count = logs.count("Paste it in Flipspin → Setup link")
        require(self.setup_banner_count == 1, "expected one setup block at boot")
        require("Setup code: " + code in logs, "setup block has no setup code")
        require("Flipspin is running · " in logs, "setup block has no running line")
        require(bool(re.search(r"krobi://[0-9.]+:8000/setup#" + re.escape(code), logs)),
                "setup block has no setup link")
        require(bool(re.search(r"Address: http://(?!127\.|0\.0\.0\.0)[0-9.]+:8000", logs)),
                "setup block has no non-loopback address")

    def claim(self):
        payload = {"label": LABEL, "nestName": NAME}
        self.request("/api/claim", expected=401, body=payload)
        setup_path = self.data / "Krobi/setup-token"
        payload["setupToken"] = setup_path.read_text().strip()
        require(bool(payload["setupToken"]), "empty setup token")
        self.token = json.loads(self.request("/api/claim", expected=201, body=payload)[0]).get("token")
        require(bool(self.token), "claim returned no account token")
        self.request("/api/claim", expected=409, body=payload)
        require(not setup_path.exists(), "setup-token still exists after claim")
        status = self.get_json("/api/status")
        require("dataDir" not in status, "dataDir leaked after claim")
        require(status.get("name") == NAME, "nest name not saved")
        self.account = self.get_json("/api/me")
        require(self.account.get("label") == LABEL, "owner label not saved")

    def find_song(self, title="Canción", album_name="Test Album", artist="Test Artist"):
        # Library reads serve the current snapshot while the watcher scans.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            albums = self.get_json("/api/listar-albums-con-metadata?covers=false")
            for album in albums:
                for track in album["tracks"]:
                    if track.get("title") == title:
                        if artist:
                            require(album.get("artist") == artist, "artist tag missing")
                        require(album.get("album") == album_name, "album name differs")
                        key = album["mediaKey"]
                        rel = track["relPath"]
                        require(rel.startswith(key + "/"), "relPath does not use album mediaKey")
                        file_key = rel[len(key) + 1:]
                        return "/api/media/" + urllib.parse.quote(key, safe="") + "/" + urllib.parse.quote(file_key, safe="")
            time.sleep(0.1)
        raise RuntimeError("song missing from listing")

    def media(self):
        self.docker("exec", "--user", f"{os.getuid()}:{os.getgid()}", self.container,
                    "mkdir", "-p", "/music/Test Artist/Test Album")
        self.docker("exec", "--user", f"{os.getuid()}:{os.getgid()}", self.container,
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=5", "-c:a", "libmp3lame",
                    "-metadata", "artist=Test Artist", "-metadata", "album=Test Album",
                    "-metadata", "title=Canción", "-metadata", "track=1", "/music/" + SONG)
        self.media_path = self.find_song()
        self.song_bytes = (self.music / SONG).read_bytes()
        content, headers = self.request(self.media_path)
        require(content == self.song_bytes, "media bytes differ from full file")
        require(int(headers["Content-Length"]) == len(self.song_bytes), "incorrect full Content-Length")
        content, headers = self.request(self.media_path, expected=206, headers={"Range": "bytes=0-99"})
        require(content == self.song_bytes[:100], "range bytes differ")
        require(headers["Content-Range"] == f"bytes 0-99/{len(self.song_bytes)}", "incorrect Content-Range")

        # A root file must share the same two-segment media wire as folders.
        self.docker("exec", "--user", f"{os.getuid()}:{os.getgid()}", self.container,
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", "/music/Loose Song.mp3")
        self.root_media_path = self.find_song("Loose Song", "Loose songs", None)
        self.root_song_bytes = (self.music / "Loose Song.mp3").read_bytes()
        content, headers = self.request(self.root_media_path, expected=206, headers={"Range": "bytes=0-99"})
        require(content == self.root_song_bytes[:100], "root song range bytes differ")
        require(headers["Content-Range"] == f"bytes 0-99/{len(self.root_song_bytes)}", "incorrect root Content-Range")

    def restart(self):
        self.docker("restart", self.container)
        self.update_base()
        self.wait_healthy()
        status = self.get_json("/api/status")
        require(status.get("name") == NAME and status.get("isInit") is True, "name/init lost on restart")
        require("dataDir" not in status, "dataDir leaked after restart")
        account = self.get_json("/api/me")
        require(all(account.get(key) == self.account.get(key)
                    for key in ("id", "label", "role", "isOwner", "source", "username", "createdAt")),
                "account changed after restart")
        require(self.find_song() == self.media_path, "song identity changed after restart")
        require(self.request(self.media_path)[0] == self.song_bytes, "song bytes lost after restart")
        require(self.find_song("Loose Song", "Loose songs", None) == self.root_media_path,
                "root song identity changed after restart")
        require(self.request(self.root_media_path)[0] == self.root_song_bytes, "root song bytes lost after restart")
        require(self.container_logs().count("Paste it in Flipspin → Setup link") == self.setup_banner_count,
                "setup block appeared after claim/restart")

    def isolation(self):
        result = self.inside('''
import json
from pathlib import Path
rows = []
for proc in Path('/proc').glob('[0-9]*'):
    try:
        argv = (proc / 'cmdline').read_bytes().split(b'\\0')
        # tini's argv contains its child command too; it is expected to be root.
        if Path(argv[0].decode()).name == 'tini':
            continue
        # QEMU/Rosetta prepend their own executable/interpreter arguments.
        if any(Path(arg.decode()).name == 'uvicorn' for arg in argv if arg):
            line = next(s for s in (proc / 'status').read_text().splitlines() if s.startswith('Uid:'))
            rows.append([int(value) for value in line.split()[1:]])
    except (OSError, StopIteration):
        pass
print(json.dumps(rows))
''')
        uids = json.loads(result)
        require(bool(uids) and all(row == [os.getuid()] * 4 for row in uids),
                f"uvicorn UID mismatch: {uids}, expected {os.getuid()}")
        mode = stat.S_IMODE((self.data / "Krobi/users.json").stat().st_mode)
        require(mode == 0o600, f"host users.json mode is {mode:o}, expected 600")
        # docker diff checks the whole writable layer, including deletions. The
        # only permitted changes outside mounts are the entrypoint's UID/GID
        # account remapping and its parent directory. No broad /tmp/HOME ignore.
        allowed = {"/etc", "/etc/.pwd.lock"}
        for name in ("passwd", "group", "shadow", "gshadow", "subuid", "subgid"):
            allowed.update(("/etc/" + name, "/etc/" + name + "-"))
        changes = self.docker("diff", self.container).splitlines()
        unexpected = []
        for change in changes:
            path = change[2:]
            if path not in allowed and not any(path == mount or path.startswith(mount + "/")
                                               for mount in ("/data", "/music")):
                unexpected.append(change)
        require(not unexpected, f"writes outside mounts/account remapping: {unexpected}")

    def container_logs(self):
        # Docker puts application stderr on the docker CLI's stderr too.
        result = subprocess.run(["docker", "logs", self.container], capture_output=True, text=True, check=True)
        return result.stdout + result.stderr

    def logs(self):
        logs = self.container_logs()
        bad = [line for line in logs.splitlines() if "Traceback" in line or re.search(r"\bERROR\b", line)]
        require(not bad, f"container log contains {len(bad)} Traceback/ERROR lines")

    def cleanup(self):
        try:
            result = subprocess.run(["docker", "rm", "-f", self.container],
                                    capture_output=True, text=True, check=False)
            require(result.returncode == 0 or "No such container" in result.stderr,
                    "could not remove QA container")
        finally:
            shutil.rmtree(self.temp)
        require(not self.temp.exists(), "temporary directories remain")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", default=os.environ.get("QA_PLATFORM") or None)
    parser.add_argument("--builder", default=os.environ.get("QA_BUILDER") or None)
    args = parser.parse_args()
    qa = InstallQA(args)
    failed = False
    blocked = False
    steps = [
        ("1 build working-tree image", qa.build),
        ("2 empty mounts, API health and Docker healthy", qa.boot),
        ("3 unclaimed status, English setup block and private code", qa.unclaimed_status),
        ("4 guarded claim and setup-token removal", qa.claim),
        ("5 nested and root MP3s, full media and Range", qa.media),
        ("6 restart persists name, account and song", qa.restart),
        ("7 requested UID, host mode 0600 and confined writes", qa.isolation),
        ("8 logs contain no Traceback/ERROR", qa.logs),
    ]

    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        for label, action in steps:
            try:
                # Logs are still useful after any earlier failure.
                require(not blocked or action == qa.logs, "blocked by an earlier failed check")
                action()
                print("PASS " + label, flush=True)
            except (Exception, KeyboardInterrupt) as error:  # noqa: BLE001 - report each check and always clean up
                failed = blocked = True
                # Do not print HTTP bodies, tokens, or container logs.
                detail = str(error)
                if isinstance(error, subprocess.CalledProcessError):
                    detail = "Docker command failed"
                    if error.stderr:
                        detail += ": " + error.stderr.strip().replace("\n", " | ")[-1000:]
                print(f"FAIL {label}: {detail}", flush=True)
    finally:
        # Ignore a second Ctrl-C/SIGTERM while removing the container and dirs.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            qa.cleanup()
            print("PASS 9 cleanup container and temporary directories", flush=True)
        except Exception as error:  # noqa: BLE001 - cleanup failure must make QA fail
            failed = True
            print(f"FAIL 9 cleanup: {error}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
