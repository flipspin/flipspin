"""Shipped proxy attribution trusts only explicit proxy peers."""
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from uvicorn import Config
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

ROOT = Path(__file__).resolve().parents[3]


def test_shipped_services_defer_to_loopback_default_and_env_override():
    unit = (ROOT / 'deploy/krobi-backend.service').read_text()
    dockerfile = (ROOT / 'backend/Dockerfile').read_text()
    compose = (ROOT / 'docker-compose.yml').read_text()
    assert 'Environment=FORWARDED_ALLOW_IPS=127.0.0.1' in unit
    assert 'ENV FORWARDED_ALLOW_IPS=127.0.0.1' in dockerfile
    assert '${FORWARDED_ALLOW_IPS:-127.0.0.1}' in compose
    # A CLI flag would override Uvicorn's environment policy.
    assert '--forwarded-allow-ips' not in unit + dockerfile


def test_spoofed_forwarding_header_cannot_rotate_throttle_peer(monkeypatch):
    monkeypatch.delenv('FORWARDED_ALLOW_IPS', raising=False)
    application = FastAPI()
    @application.get('/')
    def peer(request: Request):
        return request.client.host
    default = Config(application).forwarded_allow_ips
    for forwarded in ['198.51.100.1', '198.51.100.2']:
        protected = ProxyHeadersMiddleware(application, trusted_hosts=default)
        response = TestClient(protected, client=('192.0.2.1', 5000)).get('/', headers={'X-Forwarded-For': forwarded})
        assert response.json() == '192.0.2.1'
    monkeypatch.setenv('FORWARDED_ALLOW_IPS', '192.0.2.1')
    configured = ProxyHeadersMiddleware(application, trusted_hosts=Config(application).forwarded_allow_ips)
    assert TestClient(configured, client=('192.0.2.1', 5000)).get('/', headers={'X-Forwarded-For': '198.51.100.1'}).json() == '198.51.100.1'
