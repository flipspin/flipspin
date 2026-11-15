"""Exercise urllib's real redirect processing without sockets or TLS fixtures."""
import io
from email.message import Message
from urllib import error, request, response

import pytest

from krobi_helper.agent import Agent


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
@pytest.mark.parametrize("target, expected", [
    ("http://nest.example/next", "Bearer planted-secret"),
    ("http://NEST.example:80/next", "Bearer planted-secret"),
    ("http://other.example/next", None),
    ("https://nest.example/next", None),
    ("http://nest.example:8080/next", None),
])
def test_redirect_scopes_authorization(monkeypatch, code, target, expected):
    seen = []

    class Transport(request.HTTPHandler, request.HTTPSHandler):
        def http_open(self, req):
            seen.append((req.full_url, req.get_header("Authorization")))
            headers = Message()
            status = code if len(seen) == 1 else 200
            if len(seen) == 1:
                headers["Location"] = target
            reply = response.addinfourl(io.BytesIO(b"OK"), headers, req.full_url, status)
            reply.msg = "response"
            return reply

        https_open = http_open

    build_opener = request.build_opener
    monkeypatch.setattr(request, "build_opener", lambda *handlers: build_opener(
        request.ProxyHandler({}), Transport(), *handlers))
    worker = Agent.__new__(Agent)
    worker.custom_headers = {}
    req = request.Request("http://nest.example/start", headers={"Authorization": "Bearer planted-secret"})
    with worker._urlopen(req, timeout=1) as reply:
        assert reply.read() == b"OK"
    assert seen[0][1] == "Bearer planted-secret"
    assert seen[1][1] == expected
    assert req.get_header("Authorization") == "Bearer planted-secret"


def test_redirect_does_not_restore_authorization_on_return_to_origin():
    from krobi_helper.agent import OriginScopedRedirect

    handler = OriginScopedRedirect()
    first = request.Request("https://nest.example/start", headers={"Authorization": "Bearer planted-secret"})
    cross = handler.redirect_request(first, None, 302, "redirect", {}, "https://other.example/next")
    back = handler.redirect_request(cross, None, 302, "redirect", {}, "https://nest.example/end")
    assert cross.get_header("Authorization") is None
    assert back.get_header("Authorization") is None


def test_custom_proxy_secrets_still_disable_redirects(monkeypatch):
    class Transport(request.HTTPHandler):
        def http_open(self, req):
            headers = Message()
            headers["Location"] = "http://other.example/next"
            reply = response.addinfourl(io.BytesIO(), headers, req.full_url, 302)
            reply.msg = "redirect"
            return reply

    build_opener = request.build_opener
    monkeypatch.setattr(request, "build_opener", lambda *handlers: build_opener(
        request.ProxyHandler({}), Transport(), *handlers))
    worker = Agent.__new__(Agent)
    worker.custom_headers = {"X-Proxy-Secret": "planted-proxy-secret"}
    with pytest.raises(error.HTTPError, match="302"):
        worker._urlopen(request.Request("http://nest.example/start", headers=worker.custom_headers), timeout=1)
