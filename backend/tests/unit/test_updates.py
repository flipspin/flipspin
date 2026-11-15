"""contract checks: fake streamed transport, no real network."""
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests
from app.infra import updates
from app.infra.updates import BODY_CAP, DAY, FLOOR, UpdateChecker, newer


class Response:
    def __init__(self, status=200, body=None, headers=None, chunks=None):
        self.status_code = status
        self.headers = headers or {}
        self.body = json.dumps(body if body is not None else {"tag_name": "v2.2.0"}).encode()
        self.chunks = chunks
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def iter_content(self, chunk_size):
        yield from self.chunks if self.chunks is not None else [self.body]


@pytest.fixture
def checker(tmp_path):
    clock = [1_800_000_000.0]
    job = UpdateChecker(SimpleNamespace(update_check=True, update_check_file=tmp_path / "update-check.json"),
                        transport=Mock(return_value=Response(headers={"ETag": '"one"'})), clock=lambda: clock[0])
    job.test_clock = clock
    return job


def advance(job, seconds=FLOOR):
    job.test_clock[0] += seconds


@pytest.mark.parametrize("latest,current,expected", [
    ("v1.2.0", "1.1.0", True), ("1.2.0", "1.2.0-rc.1", True), ("1.2.0-rc.1", "1.2.0", False),
    ("1.2.0+build", "v1.2.0", False), ("1.2.0+build", "1.1.9+other", True), ("1.2.0", "2.1.2", False),
    ("bad", "0.1.0", False), ("0.1.0", "garbage", False), ("1.2.0", "1.2.0", False),
    ("0.1.0-rc.10", "0.1.0-rc.2", True), ("0.1.0-beta", "0.1.0-2", True),
    ("0.1.0-rc.1", "0.1.0-rc", True), ("0.1.0-01", "0.1.0", False), (None, "0.1.0", False),
])
def test_update_compare(latest, current, expected):
    assert newer(latest, current) is expected


def test_update_job(checker):
    assert checker.check()
    row = checker.read()
    assert row["latest"] == "2.2.0" and row["lastError"] is None
    assert checker.config.update_check_file.stat().st_mode & 0o777 == 0o644
    args, kwargs = checker.transport.call_args
    assert args == ("https://api.github.com/repos/flipspin/flipspin/releases/latest",)
    assert kwargs == dict(headers={"Accept": "application/vnd.github+json", "User-Agent": f"Flipspin/{updates.APP_VERSION} ( https://github.com/flipspin/flipspin )"}, timeout=10, stream=True, allow_redirects=False)
    advance(checker)
    checker.transport.return_value = Response(304)
    assert checker.check()
    assert checker.read() == dict(row, checkedAt=datetime.fromtimestamp(checker.clock(), UTC).isoformat())
    assert checker.transport.call_args.kwargs["headers"]["If-None-Match"] == '"one"'
    advance(checker)
    checker.transport.return_value = Response(404)
    assert checker.check() and checker.read()["lastError"] == "no-release"
    assert checker.read()["checkedAt"] == datetime.fromtimestamp(checker.clock(), UTC).isoformat()
    advance(checker)
    checker.transport.return_value = Response(403, headers={"x-ratelimit-reset": str(checker.clock() + 30 * 3600)})
    assert checker.check() and checker.read()["lastError"] == "rate-limited"
    count = checker.transport.call_count
    advance(checker, DAY)
    assert not checker.check() and checker.transport.call_count == count
    advance(checker, 6 * 3600)
    checker.transport.side_effect = requests.Timeout()
    assert checker.check() and checker.read()["lastError"] == "unreachable"
    advance(checker)
    checker.transport.side_effect = None
    checker.transport.return_value = Response(body={"tag_name": "v9.0.0-rc.1"})
    assert checker.check() and checker.read()["lastError"] == "bad-response"
    assert checker.read()["latest"] == "2.2.0"


@pytest.mark.parametrize("response", [Response(302), Response(500), Response(body=[]),
    Response(body={"tag_name": "not a command; rm"}), Response(body={"tag_name": "v3.0.0", "draft": True}),
    Response(body={"tag_name": "v3.0.0", "prerelease": True}), Response(chunks=[b'not json']),
    Response(chunks=[b'x' * 65536] * (BODY_CAP // 65536 + 1))])
def test_update_job_bad_response_and_cap(checker, response):
    checker.transport.return_value = response
    assert checker.check() and checker.read()["lastError"] == "bad-response"
    assert response.closed


def test_update_job_concurrency(checker):
    entered, release = threading.Event(), threading.Event()
    def fetch(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return Response()
    checker.transport.side_effect = fetch
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(checker.check) for _ in range(10)]
        assert entered.wait(5)
        release.set()
        assert sum(f.result() for f in futures) == 1
    assert not checker.check() and checker.transport.call_count == 1
    assert not UpdateChecker(checker.config, transport=checker.transport, clock=checker.clock).check()


def test_update_disabled_makes_no_request(checker, monkeypatch):
    timer = Mock()
    monkeypatch.setattr(updates.threading, "Timer", timer)
    checker.config.update_check = False
    checker.refresh(startup=True)
    checker.refresh()
    assert not checker.check() and checker.describe()["checking"] is False
    checker.transport.assert_not_called()
    timer.assert_not_called()
    checker.config.update_check = True
    checker.refresh()
    timer.assert_called_once()
    assert timer.call_args.args[0] == 0
    checker.stop()


def test_startup_freshness_jitter_and_pytest_guard(checker, monkeypatch):
    timer = Mock()
    monkeypatch.setattr(updates.threading, "Timer", timer)
    checker.refresh(startup=True)
    assert timer.call_args.args[0] == 60
    checker.check()
    checker.refresh(startup=True)
    assert DAY <= timer.call_args.args[0] < DAY + 3600
    checker._run()
    assert timer.call_args.args[0] == checker._daily_delay(checker.clock())
    checker.stop()
    default = UpdateChecker(checker.config)
    assert not default.enabled() and not default.check()
    default.refresh(startup=True)
    assert default.timer is None


@pytest.mark.parametrize("install", ["script", "compose", "unraid", "systemd", "desktop", "unknown", "spoofed"])
@pytest.mark.parametrize("pinned", [False, True])
def test_update_command(checker, monkeypatch, install, pinned):
    monkeypatch.delenv("KROBI_SUPERVISOR", raising=False)
    monkeypatch.setenv("KROBI_INSTALL_METHOD", install)
    monkeypatch.setenv("KROBI_TAG", "v2.1.2" if pinned else "latest")
    checker.transport.return_value = Response(body={"tag_name": "v2.2.0", "html_url": "https://evil.test/", "body": "evil prose"})
    checker.check()
    body = checker.describe()
    assert body["pinned"] == pinned
    assert body["install"] == ("unknown" if install == "spoofed" else install)
    expected = "docker compose pull && docker compose up -d" if install == "compose" else "krobi update" if install == "script" and not pinned else None
    assert body["command"] == expected
    assert body["releaseUrl"] == "https://github.com/flipspin/flipspin/releases/tag/v2.2.0"
    assert "evil" not in checker.config.update_check_file.read_text()
    monkeypatch.setenv("KROBI_SUPERVISOR", "desktop")
    assert checker.describe()["install"] == "desktop" and checker.describe()["command"] is None
    checker.config.update_check = False
    assert not checker.describe()["updateAvailable"]


@pytest.mark.parametrize("text", ['{broken', '[]', '{"latest":"evil"}', '{"lastError": []}', '{"lastError":"other"}'])
def test_corrupt_record_is_never(checker, text):
    checker.config.update_check_file.write_text(text)
    body = checker.describe()
    assert body["latest"] is None and body["checkedAt"] is None and not body["updateAvailable"]
    assert checker.check() and checker.read()["latest"] == "2.2.0"


def test_state_change_logging(checker, caplog):
    caplog.set_level(logging.INFO, logger=updates.__name__)
    for response in [Response(), Response(), Response(404), Response(404), Response(429), Response()]:
        checker.transport.return_value = response
        advance(checker, 2 * DAY)
        checker.check()
    assert [r.message for r in caplog.records if r.name == updates.__name__] == ["update check: ok latest=2.2.0", "update check: failed no-release", "update check: failed rate-limited", "update check: ok latest=2.2.0"]


@pytest.mark.parametrize("headers,delay", [({"retry-after": "9999999"}, 2 * DAY), ({"retry-after": "90000"}, 90000), ({"retry-after": "garbage"}, DAY)])
def test_rate_backoff(checker, headers, delay):
    assert checker._backoff(headers, checker.clock()) == checker.clock() + delay


def test_failed_bookkeeping_never_raises_and_keeps_process_floor(checker, monkeypatch):
    monkeypatch.setattr(updates, "write_json_atomic", Mock(side_effect=OSError("disk full")))
    assert checker.check()
    assert not checker.check()
    checker.transport.assert_called_once()


def test_canceled_timer_does_not_schedule_another_daily_job(checker, monkeypatch):
    timer = Mock()
    monkeypatch.setattr(updates.threading, "Timer", timer)
    checker.refresh(startup=True)
    old = checker.generation
    checker.config.update_check = False
    checker.refresh()
    checker.config.update_check = True
    checker.refresh()
    assert timer.call_count == 2
    checker._run(old)
    assert timer.call_count == 2
    checker.stop()


def test_unraid_declaration_and_absent_declaration(checker, monkeypatch):
    monkeypatch.delenv("KROBI_SUPERVISOR", raising=False)
    monkeypatch.delenv("KROBI_INSTALL_METHOD", raising=False)
    monkeypatch.delenv("KROBI_TAG", raising=False)
    assert checker.describe()["install"] == "unknown"
    assert checker.describe()["command"] is None and not checker.describe()["pinned"]


def test_rate_limit_date_and_48_hour_schedule(checker):
    from email.utils import format_datetime
    until = checker.clock() + 30 * 3600
    assert checker._backoff({"retry-after": format_datetime(datetime.fromtimestamp(until, UTC))}, checker.clock()) == until
    checker.check()
    checker.deferred_until = checker.clock() + 2 * DAY
    assert checker._daily_delay(checker.clock()) == 2 * DAY
