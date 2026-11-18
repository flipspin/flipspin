"""A query-auth credential must not become a recoverable log record."""
import logging

import pytest
from httpx import URL
from uvicorn.logging import AccessFormatter

from app.infra.logging import CredentialQueryFilter


@pytest.mark.parametrize("name", ["apiKey", "api%4Bey", "p", "t", "jwt"])
def test_subsonic_credentials_are_redacted_in_the_actual_log_file(config, name):
    url = URL(f"http://nest/rest/ping?{name}=secret-value&f=json")
    logging.getLogger("httpx").info("HTTP Request: %s %s", "GET", url)
    logged = (config.log_dir / "krobi.log").read_text()
    assert "secret-value" not in logged
    assert f"{name}=[REDACTED]&f=json" in logged


def test_subsonic_uvicorn_access_log_keeps_its_formatter_contract():
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:1234", "GET", "/rest/ping.view?apiKey=secret-value&c=test", "1.1", 200), None)
    for filter_ in logging.getLogger("uvicorn.access").filters:
        filter_.filter(record)
    assert any(isinstance(f, CredentialQueryFilter) for f in logging.getLogger("uvicorn.access").filters)
    formatted = AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False).format(record)
    assert "secret-value" not in formatted
    assert "apiKey=[REDACTED]&c=test" in formatted
    assert "200" in formatted


def test_subsonic_query_credentials_are_redacted_in_interpolated_messages_and_mapping_args():
    record = logging.LogRecord("test", logging.INFO, __file__, 1,
                               "Failed /rest/ping?apiKey=first: %(url)s",
                               ({"url": "/rest/stream?u=ana&p=second&id=song"},), None)
    CredentialQueryFilter().filter(record)
    message = record.getMessage()
    assert "first" not in message and "second" not in message
    assert "u=ana" in message and "id=song" in message
