"""Exercise address policy, redirect checks, streaming bounds and the pinned socket."""
from contextlib import contextmanager
from ipaddress import ip_address, IPv6Address
from types import SimpleNamespace
from unittest.mock import Mock
import socket

import pytest
from pydantic import TypeAdapter, ValidationError
from urllib3.exceptions import ReadTimeoutError

from app.infra import http_fetch as fetch
from app.infra.urls import DownloaderURL, Host, UserURL, SourceURL


@pytest.fixture
def public_dns(monkeypatch):
    resolver = Mock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))])
    monkeypatch.setattr(fetch.socket, 'getaddrinfo', resolver)
    return resolver


def transport(monkeypatch, replies):
    calls = []
    @contextmanager
    def once(url, address, headers, timeout):
        calls.append((url, address, dict(headers), timeout))
        yield next(replies)
    monkeypatch.setattr(fetch, '_request_once', once)
    return calls


def reply(status=200, headers=None, chunks=(b'image',)):
    return SimpleNamespace(status=status, headers=headers or {'Content-Type': 'image/jpeg'},
                           stream=lambda **kw: iter(chunks))


@pytest.mark.parametrize('address', [
    ip_address(0x7F000001), ip_address(0x0A000001), ip_address(0xA9FE0001),
    ip_address(0xE0000001), ip_address(0), IPv6Address(1),
    IPv6Address(0xFD000000000000000000000000000001),
    IPv6Address('::ffff:' + str(ip_address(0x7F000001))),
])
def test_non_public_dns_never_opens_connection(monkeypatch, address):
    monkeypatch.setattr(fetch.socket, 'getaddrinfo', lambda *a, **kw: [
        (socket.AF_INET6 if address.version == 6 else socket.AF_INET, socket.SOCK_STREAM, 6, '', (str(address), 443))])
    network = Mock()
    monkeypatch.setattr(fetch, '_request_once', network)
    with pytest.raises(fetch.UnsafeFetch):
        fetch.safe_get('https://example.org/art', image=True)
    network.assert_not_called()


def test_mixed_public_and_private_answers_fail_closed(public_dns, monkeypatch):
    public_dns.return_value.append((socket.AF_INET6, socket.SOCK_STREAM, 6, '', (str(IPv6Address(1)), 443)))
    network = Mock()
    monkeypatch.setattr(fetch, '_request_once', network)
    with pytest.raises(fetch.UnsafeFetch):
        fetch.safe_get('https://example.org')
    network.assert_not_called()


def test_redirects_re_resolve_even_on_same_host(public_dns, monkeypatch):
    public_dns.side_effect = [public_dns.return_value, [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (str(ip_address(0x7F000001)), 443))]]
    calls = transport(monkeypatch, iter([reply(302, {'Location': '/private'})]))
    with pytest.raises(fetch.UnsafeFetch):
        fetch.safe_get('https://example.org/art', image=True)
    assert len(calls) == 1
    assert public_dns.call_count == 2


@pytest.mark.parametrize('redirects,accepted', [(3, True), (4, False)])
def test_at_most_three_redirects(public_dns, monkeypatch, redirects, accepted):
    calls = transport(monkeypatch, iter([reply(302, {'Location': '/next'}) for _ in range(redirects)] + [reply()]))
    if accepted:
        assert fetch.safe_get('https://example.org/art', image=True).content == b'image'
    else:
        with pytest.raises(fetch.UnsafeFetch):
            fetch.safe_get('https://example.org/art', image=True)
    assert len(calls) == 4


def test_redirect_drops_credentials_and_checks_allowlist(public_dns, monkeypatch):
    calls = transport(monkeypatch, iter([reply(302, {'Location': 'https://other.example.org/art'}), reply()]))
    assert fetch.safe_get('https://example.org/art', headers={'Authorization': 'secret', 'Cookie': 'secret'}).content == b'image'
    assert 'Authorization' not in calls[1][2] and 'Cookie' not in calls[1][2]
    calls = transport(monkeypatch, iter([reply(302, {'Location': 'https://other.example.org/art'})]))
    with pytest.raises(fetch.UnsafeFetch):
        fetch.safe_get('https://example.org/art', allowed_hosts={'example.org'})
    assert len(calls) == 1


def test_stream_cap_without_content_length_stops_reading(public_dns, monkeypatch):
    chunks_read = []
    def chunks(**kw):
        for index in range(12):
            chunks_read.append(index)
            yield b'x' * (1024 * 1024)
    response = reply()
    response.stream = chunks
    transport(monkeypatch, iter([response]))
    with pytest.raises(fetch.UnsafeFetch, match='10 MiB'):
        fetch.safe_get('https://example.org/art', image=True)
    assert len(chunks_read) == 11


@pytest.mark.parametrize('headers', [
    {'Content-Type': 'image/jpeg', 'Content-Length': str(fetch.MAX_BYTES + 1)},
    {'Content-Type': 'image/jpeg', 'Content-Encoding': 'gzip'},
    {'Content-Type': 'text/html'},
    {'Content-Length': 'invalid'},
])
def test_bad_headers_refused_before_read(public_dns, monkeypatch, headers):
    response = reply(headers=headers)
    response.stream = Mock(side_effect=AssertionError('body must not be read'))
    transport(monkeypatch, iter([response]))
    with pytest.raises(fetch.UnsafeFetch):
        fetch.safe_get('https://example.org/art', image=True)
    response.stream.assert_not_called()


def test_exact_cap_and_image_parameter_content_type(public_dns, monkeypatch):
    body = b'x' * fetch.MAX_BYTES
    transport(monkeypatch, iter([reply(headers={'content-type': 'IMAGE/PNG; charset=binary'}, chunks=[body])]))
    assert fetch.safe_get('https://example.org/art', image=True).content == body


def test_connection_uses_checked_ip_with_tls_hostname(public_dns, monkeypatch):
    pool = Mock()
    pool.urlopen.return_value = reply(chunks=[b'ok'])
    pool.urlopen.return_value.close = Mock()
    factory = Mock(return_value=pool)
    monkeypatch.setattr(fetch, 'HTTPSConnectionPool', factory)
    assert fetch.safe_get('https://example.org/art?q=x').content == b'ok'
    assert public_dns.call_count == 1  # No second DNS lookup when connecting.
    assert factory.call_args.args == ('93.184.216.34', 443)
    assert factory.call_args.kwargs['server_hostname'] == 'example.org'
    assert factory.call_args.kwargs['assert_hostname'] == 'example.org'
    assert factory.call_args.kwargs['cert_reqs'] == 'CERT_REQUIRED'
    timeout = factory.call_args.kwargs['timeout']
    assert timeout.connect_timeout == 5 and timeout.read_timeout == 10
    assert pool.urlopen.call_args.args == ('GET', '/art?q=x')
    assert pool.urlopen.call_args.kwargs['headers']['Host'] == 'example.org'
    assert pool.urlopen.call_args.kwargs['redirect'] is False
    pool.close.assert_called_once()
    pool.urlopen.return_value.close.assert_called_once()


def test_transport_timeout_is_a_request_failure(public_dns, monkeypatch):
    pool = Mock()
    pool.urlopen.side_effect = ReadTimeoutError(None, '/', 'timeout')
    monkeypatch.setattr(fetch, 'HTTPConnectionPool', Mock(return_value=pool))
    with pytest.raises(fetch.UnsafeFetch):
        fetch.safe_get('http://example.org')
    pool.close.assert_called_once()


@pytest.mark.parametrize('url', ['--exec=echo bad', 'ftp://example.org/a', 'https://user@example.org/a',
                              'https://example.org\\@evil.example/a', ' https://example.org',
                              'https://example.org:99999', 'https://example.org/%0a'])
def test_url_validation(url):
    # An encoded path newline is data, not an authority or command delimiter.
    if url.endswith('%0a'):
        assert TypeAdapter(UserURL).validate_python(url) == url
    else:
        with pytest.raises(ValidationError):
            TypeAdapter(UserURL).validate_python(url)


def test_downloader_host_extension_applies_to_legacy_source_fields(monkeypatch):
    monkeypatch.setenv('KROBI_DOWNLOADER_ALLOWED_HOSTS', 'media.example.org')
    url = 'https://media.example.org/audio'
    assert TypeAdapter(DownloaderURL).validate_python(url) == url
    for disallowed in [url.replace('media.', 'sub.media.'), 'https://youtube.com.evil.example/audio']:
        with pytest.raises(ValidationError):
            TypeAdapter(DownloaderURL).validate_python(disallowed)
    assert TypeAdapter(SourceURL).validate_python(url) == url


@pytest.mark.parametrize('value', ['vlc.example.org:8080', str(ip_address(0x7F000001)), f'[{IPv6Address(1)}]:8080'])
def test_vlc_host_preserves_local_hosts_and_ports(value):
    assert TypeAdapter(Host).validate_python(value) == value
