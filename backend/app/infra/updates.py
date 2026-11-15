"""Owner-only release facts. No feed text, URLs or commands are trusted."""
import json
import logging
import os
import random
import re
import sys
import threading
import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import requests

from app.config import APP_VERSION
from app.infra.files import write_json_atomic

SOURCE_URL = "https://api.github.com/repos/flipspin/flipspin/releases/latest"
DAY = 86400
FLOOR = 300
BODY_CAP = 1024 * 1024
ERRORS = {"unreachable", "rate-limited", "no-release", "bad-response"}
logger = logging.getLogger(__name__)
SEMVER = re.compile(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?")


def version(value):
    if not isinstance(value, str) or not (match := SEMVER.fullmatch(value)):
        return None
    pre = match[4]
    if pre and any(not p or (p.isdigit() and len(p) > 1 and p[0] == "0") for p in pre.split(".")):
        return None
    if match[5] and any(not p for p in match[5].split(".")):
        return None
    try:
        return tuple(int(match[i]) for i in (1, 2, 3)), pre
    except ValueError:
        return None


def newer(latest, current):
    a, b = version(latest), version(current)
    if a is None or b is None:
        return False
    if a[0] != b[0]:
        return a[0] > b[0]
    if a[1] is None or b[1] is None:
        return a[1] is None and b[1] is not None
    for left, right in zip(a[1].split("."), b[1].split("."), strict=False):
        if left != right:
            if left.isdigit() and right.isdigit():
                return int(left) > int(right)
            if left.isdigit() != right.isdigit():
                return not left.isdigit()
            return left > right
    return len(a[1].split(".")) > len(b[1].split("."))


def timestamp(value):
    try:
        return datetime.fromisoformat(value).timestamp() if value else 0
    except (ValueError, TypeError, OverflowError):
        return 0


def empty_record():
    return dict(latest=None, releaseTag=None, checkedAt=None, etag=None, lastError=None, lastErrorAt=None, skippedVersion=None)


class UpdateChecker:
    def __init__(self, config, *, transport=None, clock=time.time):
        self.config = config
        self.transport = transport or requests.get
        self.injected = transport is not None
        self.clock = clock
        self.lock = threading.Lock()
        self.schedule_lock = threading.Lock()
        self.timer = None
        self.minute = random.randrange(60)
        self.deferred_until = 0
        self.last_attempt = 0
        self.generation = 0

    def enabled(self):
        return self.config.update_check and ("pytest" not in sys.modules or self.injected)

    def read(self):
        try:
            raw = json.loads(self.config.update_check_file.read_text())
            if not isinstance(raw, dict):
                return empty_record()
            row = {key: raw.get(key) for key in empty_record()}
            if row["latest"] is not None and (not isinstance(row["latest"], str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", row["latest"])):
                return empty_record()
            if any(value is not None and not isinstance(value, str) for value in row.values()):
                return empty_record()
            if row["skippedVersion"] is not None and not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", row["skippedVersion"]):
                row["skippedVersion"] = None
            if row["lastError"] is not None and row["lastError"] not in ERRORS:
                return empty_record()
            for key in ("checkedAt", "lastErrorAt"):
                if row[key] is not None:
                    datetime.fromisoformat(row[key])
            return row
        except (OSError, ValueError):
            return empty_record()

    def describe(self):
        row = self.read()
        latest = row["latest"]
        install = os.getenv("KROBI_INSTALL_METHOD", "unknown")
        if os.getenv("KROBI_SUPERVISOR") == "desktop":
            install = "desktop"
        if install not in {"script", "compose", "unraid", "systemd", "desktop"}:
            install = "unknown"
        pinned = os.getenv("KROBI_TAG", "latest") != "latest"
        command = {"compose": "docker compose pull && docker compose up -d", "script": "krobi update"}.get(install)
        if pinned and install == "script":
            command = None
        return dict(checking=self.config.update_check, current=APP_VERSION, latest=latest, skipped=row["skippedVersion"],
                    updateAvailable=bool(self.config.update_check and newer(latest, APP_VERSION)),
                    releaseUrl=f"https://github.com/flipspin/flipspin/releases/tag/v{latest}" if latest else None,
                    install=install, pinned=pinned, command=command, checkedAt=row["checkedAt"], lastError=row["lastError"])

    def skip(self, selected: str | None):
        """Serialize skip/undo with release checks so neither overwrites the other."""
        with self.lock:
            row = self.read()
            if selected is not None and (not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", selected) or selected != row["latest"]):
                raise ValueError("Choose the current latest plain version")
            row["skippedVersion"] = selected
            write_json_atomic(self.config.update_check_file, row)
            return self.describe()

    def check(self):
        """Return whether a fetch ran. Contending callers read the first result."""
        with self.lock:
            if not self.enabled():
                return False
            before = self.read()
            now = self.clock()
            if now < max(timestamp(before["checkedAt"]), timestamp(before["lastErrorAt"]), self.last_attempt) + FLOOR or now < self.deferred_until:
                return False
            self.last_attempt = now
            row = dict(before)
            iso = datetime.fromtimestamp(now, UTC).isoformat()
            error = None
            try:
                headers = {"Accept": "application/vnd.github+json", "User-Agent": f"Flipspin/{APP_VERSION} ( https://github.com/flipspin/flipspin )"}
                if row["etag"]:
                    headers["If-None-Match"] = row["etag"]
                with self.transport(SOURCE_URL, headers=headers, timeout=10, stream=True, allow_redirects=False) as response:
                    status = response.status_code
                    if status == 304:
                        row["checkedAt"] = iso
                    elif status in (403, 429):
                        error = "rate-limited"
                        self.deferred_until = self._backoff(response.headers, now)
                    elif status == 404:
                        # A valid answer that there are no releases yet. The
                        # details card can say when that fact was checked.
                        row["checkedAt"] = iso
                        error = "no-release"
                    elif status == 200:
                        body = bytearray()
                        for chunk in response.iter_content(chunk_size=65536):
                            body.extend(chunk)
                            if len(body) > BODY_CAP:
                                raise ValueError("body cap")
                        release = json.loads(body)
                        tag = release.get("tag_name")
                        parsed = version(tag)
                        if release.get("prerelease") or release.get("draft") or parsed is None or parsed[1] is not None:
                            raise ValueError("release tag")
                        latest = ".".join(map(str, parsed[0]))
                        if newer(latest, row["skippedVersion"]):
                            row["skippedVersion"] = None
                        row.update(latest=latest, releaseTag=f"v{latest}", checkedAt=iso,
                                   etag=response.headers.get("ETag"), lastError=None, lastErrorAt=None)
                    else:
                        error = "bad-response"
            except requests.RequestException:
                error = "unreachable"
            except Exception:
                error = "bad-response"
            if error:
                row.update(lastError=error, lastErrorAt=iso)
            try:
                write_json_atomic(self.config.update_check_file, row)
            except OSError:
                # Bookkeeping must not fail a request or boot.
                return True
            if (before["lastError"], bool(before["checkedAt"])) != (row["lastError"], bool(row["checkedAt"])):
                if row["lastError"]:
                    logger.info("update check: failed %s", row["lastError"])
                else:
                    logger.info("update check: ok latest=%s", row["latest"])
            return True

    def _backoff(self, headers, now):
        deadlines = [now + DAY]
        for key in ("x-ratelimit-reset", "retry-after"):
            value = headers.get(key)
            if value:
                try:
                    deadlines.append(float(value) + (now if key == "retry-after" else 0))
                except ValueError:
                    try:
                        deadlines.append(parsedate_to_datetime(value).timestamp())
                    except (ValueError, TypeError, OverflowError):
                        pass
        return min(max(deadlines), now + 2 * DAY)

    def _schedule(self, delay):
        self.timer = threading.Timer(delay, self._run, args=(self.generation,))
        self.timer.daemon = True
        self.timer.start()

    def refresh(self, *, startup=False):
        with self.schedule_lock:
            self.generation += 1
            if self.timer:
                self.timer.cancel()
                self.timer = None
            if not self.enabled():
                return
            row = self.read()
            now = self.clock()
            fresh = timestamp(row["checkedAt"]) > now - DAY
            delay = self._daily_delay(now) if startup and fresh else (60 if startup else 0)
            self._schedule(delay)

    def _daily_delay(self, now):
        # Never recheck a fresh record early after a restart. Round the next
        # due hour to the process's minute; subsequent daily runs keep it.
        row = self.read()
        last = max(timestamp(row["checkedAt"]), timestamp(row["lastErrorAt"]), self.last_attempt)
        due = max(now, last + DAY)
        at = due // 3600 * 3600 + self.minute * 60
        if at < due:
            at += 3600
        return max(at, self.deferred_until) - now

    def _run(self, generation=None):
        try:
            self.check()
        finally:
            with self.schedule_lock:
                if self.enabled() and (generation is None or generation == self.generation):
                    self._schedule(self._daily_delay(self.clock()))

    def stop(self):
        with self.schedule_lock:
            self.generation += 1
            if self.timer:
                self.timer.cancel()
                self.timer = None
