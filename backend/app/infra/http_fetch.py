"""Bounded public HTTP GETs, with DNS pinned through the connection and TLS.

No ambient proxies, automatic redirects, retries or decompression: each hop is
resolved and checked here. Callers receive a buffered, size-bounded Response.
"""
from contextlib import contextmanager
from ipaddress import ip_address
import socket
from urllib.parse import urljoin, urlsplit

import requests
from requests.structures import CaseInsensitiveDict
from urllib3 import HTTPConnectionPool, HTTPSConnectionPool, Timeout
from urllib3.exceptions import HTTPError

from app.infra.urls import validate_url

MAX_BYTES = 10 * 1024 * 1024
MAX_REDIRECTS = 3


class UnsafeFetch(requests.RequestException):
    """The destination or response violates the public-fetch policy."""


def _public_address(host: str, port: int) -> str:
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses:
        raise UnsafeFetch('Host has no addresses')
    for _, _, _, _, sockaddr in addresses:
        address = ip_address(sockaddr[0])
        address = getattr(address, 'ipv4_mapped', None) or address
        if not address.is_global or address.is_multicast:
            raise UnsafeFetch('Non-public destination refused')
    return addresses[0][4][0]


@contextmanager
def _request_once(url, address, headers, timeout):
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    options = {'timeout': Timeout(connect=min(5, timeout), read=timeout), 'retries': False}
    if parsed.scheme == 'https':
        pool = HTTPSConnectionPool(address, port, server_hostname=parsed.hostname,
                                   assert_hostname=parsed.hostname, cert_reqs='CERT_REQUIRED', **options)
    else:
        pool = HTTPConnectionPool(address, port, **options)
    response = None
    try:
        target = (parsed.path or '/') + ('?' + parsed.query if parsed.query else '')
        response = pool.urlopen('GET', target,
                                headers={**headers, 'Host': parsed.netloc, 'Accept-Encoding': 'identity'},
                                redirect=False, assert_same_host=False, preload_content=False,
                                decode_content=False)
        yield response
    finally:
        if response is not None:
            response.close()
        pool.close()


def safe_get(url: str, *, headers=None, params=None, timeout: float = 10,
             image: bool = False, allowed_hosts=None) -> requests.Response:
    """Fetch at most 10 MiB, checking every resolved address on every hop."""
    headers = CaseInsensitiveDict(headers or {})
    try:
        url = requests.Request('GET', validate_url(url, allowed_hosts=allowed_hosts), params=params).prepare().url
        for hop in range(MAX_REDIRECTS + 1):
            validate_url(url, allowed_hosts=allowed_hosts)
            parsed = urlsplit(url)
            address = _public_address(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80))
            with _request_once(url, address, headers, timeout) as response:
                response_headers = CaseInsensitiveDict(response.headers)
                if response.status in (301, 302, 303, 307, 308):
                    location = response_headers.get('Location')
                    if not location or hop == MAX_REDIRECTS:
                        raise UnsafeFetch('Redirect limit or missing location')
                    next_url = urljoin(url, location)
                    if urlsplit(next_url).netloc != parsed.netloc or urlsplit(next_url).scheme != parsed.scheme:
                        for name in ('Authorization', 'Cookie', 'Proxy-Authorization'):
                            headers.pop(name, None)
                    url = next_url
                    continue
                result = requests.Response()
                result.status_code, result.headers, result.url = response.status, response_headers, url
                result.raise_for_status()
                if image and not response_headers.get('Content-Type', '').lower().startswith('image/'):
                    raise UnsafeFetch('Cover response must be an image')
                # Reject compressed bodies rather than allocate an unbounded decoder buffer.
                if response_headers.get('Content-Encoding', 'identity').lower() != 'identity':
                    raise UnsafeFetch('Encoded response refused')
                length = response_headers.get('Content-Length')
                if length is not None and int(length) > MAX_BYTES:
                    raise UnsafeFetch('Response exceeds 10 MiB')
                body = bytearray()
                for chunk in response.stream(amt=64 * 1024, decode_content=False):
                    if len(body) + len(chunk) > MAX_BYTES:
                        raise UnsafeFetch('Response exceeds 10 MiB')
                    body.extend(chunk)
                result._content = bytes(body)
                result.encoding = requests.utils.get_encoding_from_headers(result.headers)
                return result
    except requests.RequestException:
        raise
    except (ValueError, OSError, HTTPError) as exc:
        raise UnsafeFetch('Public HTTP fetch refused or failed') from exc
    raise UnsafeFetch('Redirect limit exceeded')
