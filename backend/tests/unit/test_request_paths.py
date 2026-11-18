"""Untrusted authorities cannot change the routing path or local authority."""
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException
from starlette.requests import Request

from app.infra.identity import require_api_token
from app.infra.request_paths import request_host, routing_path


def request(path='/api/health', root='', hosts=('localhost',)):
    return Request({'type': 'http', 'method': 'GET', 'path': path, 'root_path': root,
                    'query_string': b'', 'client': ('192.0.2.10', 50000),
                    'headers': [(b'host', host.encode()) for host in hosts]})


@pytest.mark.parametrize('path,root,expected', [
    ('/nest/api/health', '/nest', '/api/health'),
    ('/api/health', '/nest', '/api/health'),
    ('/nested/api/health', '/nest', '/nested/api/health'),
    ('/nest', '/nest', ''),
])
def test_root_path_is_removed_only_at_a_segment_boundary(path, root, expected):
    assert routing_path(request(path, root)) == expected


def test_public_auth_uses_routing_path_under_a_deployment_prefix():
    require_api_token(request('/nest/api/health', '/nest'), BackgroundTasks(),
                      SimpleNamespace(api_token='secret'), SimpleNamespace())
    with pytest.raises(HTTPException) as error:
        require_api_token(request('/nested/api/health', '/nest'), BackgroundTasks(),
                          SimpleNamespace(api_token='secret'), SimpleNamespace())
    assert error.value.status_code == 401


@pytest.mark.parametrize('hosts', [(), ('localhost', 'localhost'), ('localhost\t',),
                                   ('localhost/api/health#',), ('[::1]@evil',), ('host:abc',),
                                   ('host:99999999999999999999',), ('host\\evil',), ('-host',)])
def test_invalid_authorities_are_rejected(hosts):
    with pytest.raises(HTTPException) as error:
        request_host(request(hosts=hosts))
    assert error.value.status_code == 400


@pytest.mark.parametrize('host,expected', [('localhost:5173', 'localhost'), ('LOCALHOST', 'localhost'),
                                         ('[::1]:8000', '[::1]'), ('music.example:443', 'music.example')])
def test_valid_authorities(host, expected):
    assert request_host(request(hosts=(host,))) == expected


def test_container_hostnames_with_underscores_are_valid_hosts():
    from types import SimpleNamespace
    from app.infra.request_paths import request_host
    headers = SimpleNamespace(getlist=lambda name: ['flipspin_server:8000'])
    assert request_host(SimpleNamespace(headers=headers)) == 'flipspin_server'
