"""Log timestamps remain unambiguous across process and viewer timezones."""
import json
import logging
import time
from datetime import UTC, datetime

import pytest

from app.infra.logging import ConsoleFormatter, JSONFormatter, LoggerConfig


@pytest.fixture
def process_timezone(monkeypatch):
    if not hasattr(time, "tzset"):
        pytest.skip("process timezone switching requires time.tzset")
    with monkeypatch.context() as env:
        yield env
    time.tzset()


@pytest.mark.parametrize("tz, expected", [
    (None, "2026-11-13 17:34:30+00:00"),
    ("UTC", "2026-11-13 17:34:30+00:00"),
    ("EST5EDT", "2026-11-13 12:34:30-05:00"),
    ("NPT-5:45", "2026-11-13 23:19:30+05:45"),
])
def test_process_timezone_and_offset_on_console_and_json(process_timezone, tz, expected):
    # Start with a non-UTC process timezone even for the unset-TZ case.
    process_timezone.setenv("TZ", "EST5EDT")
    time.tzset()
    if tz is None:
        process_timezone.delenv("TZ")
    else:
        process_timezone.setenv("TZ", tz)
    time.tzset()
    record = logging.LogRecord("app.test", logging.ERROR, "", 0, "failed", (), None)
    record.created = datetime(2026, 11, 13, 17, 34, 30, 123456, UTC).timestamp()
    assert ConsoleFormatter().format(record).startswith(f"{expected} ERROR")
    stamp = json.loads(JSONFormatter().format(record))["timestamp"]
    assert stamp == expected.replace(" ", "T")[:-6] + ".123456" + expected[-6:]
    assert datetime.fromisoformat(stamp).timestamp() == record.created


def test_every_file_entry_has_offset_and_errors_keep_iso8601(config, process_timezone):
    process_timezone.setenv("TZ", "CST6")
    time.tzset()
    LoggerConfig.set_level("INFO")
    logger = logging.getLogger("app.test")
    logger.info("first")
    logger.error("second")
    lines = (config.log_dir / "krobi.log").read_text().splitlines()[-2:]
    assert len(lines) == 2
    assert all(line[19:25] == "-06:00" for line in lines)
    errors = (config.log_dir / "krobi_errors.log").read_text().splitlines()
    assert json.loads(errors[-1])["timestamp"].endswith("-06:00")


def test_process_timezone_applies_dst_at_record_time(process_timezone):
    process_timezone.setenv("TZ", "EST5EDT,M3.2.0,M11.1.0")
    time.tzset()
    for month, expected in [(1, "07:00:00-05:00"), (7, "08:00:00-04:00")]:
        record = logging.LogRecord("app.test", logging.INFO, "", 0, "started", (), None)
        record.created = datetime(2026, month, 1, 12, tzinfo=UTC).timestamp()
        assert expected in ConsoleFormatter().format(record)
