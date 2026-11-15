"""String-preserving URL and host validation at untrusted input boundaries."""
import ipaddress
import os
import re
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import BeforeValidator, HttpUrl

# Composition supplies the live union; infra does not import a domain registry.
_source_hosts = lambda: set()


def set_source_hosts(provider):
    global _source_hosts
    _source_hosts = provider


def validate_host(value: str) -> str:
    """A DNS name or IP, optionally with a port (VLC supports both)."""
    if not isinstance(value, str) or not value or value.startswith('-') or value.endswith(':'):
        raise ValueError('invalid-host')
    if any(c.isspace() or ord(c) < 32 for c in value) or any(c in value for c in '/\\@?#%'):
        raise ValueError('invalid-host')
    try:
        parsed = urlsplit('//' + value)
        host, port = parsed.hostname, parsed.port
        if not host or parsed.username is not None or parsed.password is not None:
            raise ValueError('invalid-host')
        if port is not None and not 1 <= port <= 65535:
            raise ValueError('invalid-host')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            ascii_host = host.rstrip('.').encode('idna').decode('ascii')
            if len(ascii_host) > 253 or not all(
                re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', label)
                for label in ascii_host.split('.')):
                raise ValueError('invalid-host') from None
    except (ValueError, UnicodeError) as exc:
        raise ValueError('invalid-host') from exc
    return value


def validate_url(value: str, *, allowed_hosts=None) -> str:
    if not isinstance(value, str) or not value or value.startswith('-'):
        raise ValueError('invalid-http-url')
    if any(c.isspace() or ord(c) < 32 for c in value) or '\\' in value:
        raise ValueError('invalid-http-url')
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc:
            raise ValueError('invalid-http-url')
        validate_host(parsed.netloc)
        if allowed_hosts is not None and parsed.hostname.lower().rstrip('.') not in allowed_hosts:
            raise ValueError('url-host-not-allowed')
    except ValueError as exc:
        raise ValueError('invalid-http-url') from exc
    return value


def downloader_url(value: str) -> str:
    extra = os.environ.get('KROBI_DOWNLOADER_ALLOWED_HOSTS', '')
    hosts = set(_source_hosts()) | {h.strip().lower().rstrip('.') for h in extra.split(',') if h.strip()}
    return validate_url(value, allowed_hosts=hosts)


def validate_http_url(value):
    # Retain compatibility with Python callers passing an existing HttpUrl.
    return validate_url(str(value) if isinstance(value, HttpUrl) else value)


UserURL = Annotated[str, BeforeValidator(validate_url)]
HttpUserURL = Annotated[HttpUrl, BeforeValidator(validate_http_url)]
SourceURL = Annotated[UserURL, BeforeValidator(downloader_url)]
DownloaderURL = Annotated[UserURL, BeforeValidator(downloader_url)]
Host = Annotated[str, BeforeValidator(validate_host)]
