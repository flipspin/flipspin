"""Tests for the CORS policy resolution used by app.main.

The default trusts Tauri and development origins. Opaque browser origins require
an explicit opt-in, and wildcard origins must never combine with credentials.
"""
import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app.infra.cors import NULL_ORIGIN, TAURI_ORIGINS, resolve_cors_settings


# --- policy resolution -----------------------------------------------------

@pytest.mark.parametrize("raw", [None, "", "   ", ",, ,"])
def test_unset_falls_back_to_defaults(raw):
    settings = resolve_cors_settings(raw)
    assert settings.allow_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        *TAURI_ORIGINS,
    ]
    assert settings.allow_credentials is True
    assert settings.warnings == []


def test_default_accepts_packaged_origins_and_refuses_opaque_origins():
    settings = resolve_cors_settings(None)
    assert all(origin in settings.allow_origins for origin in TAURI_ORIGINS)
    assert NULL_ORIGIN not in settings.allow_origins


def test_explicit_list_is_honoured_and_trimmed():
    raw = " http://192.168.1.20:5173 , tauri://localhost , http://tauri.localhost , https://tauri.localhost "
    settings = resolve_cors_settings(raw)
    assert settings.allow_origins == ["http://192.168.1.20:5173", *TAURI_ORIGINS]
    assert settings.allow_credentials is True
    assert settings.warnings == []


def test_explicit_list_deduplicates_preserving_order():
    settings = resolve_cors_settings("null,http://a,null,http://a,http://b")
    assert settings.allow_origins == ["null", "http://a", "http://b"]


def test_explicit_list_without_tauri_origins_warns():
    settings = resolve_cors_settings("http://192.168.1.20:5173")
    assert settings.allow_origins == ["http://192.168.1.20:5173"]
    assert len(settings.warnings) == 1
    assert "tauri://localhost" in settings.warnings[0]


def test_wildcard_disables_credentials():
    # "*" + allow_credentials is invalid per the CORS spec; browsers reject it.
    settings = resolve_cors_settings("*")
    assert settings.allow_origins == ["*"]
    assert settings.allow_credentials is False
    assert settings.warnings


def test_wildcard_wins_over_other_entries():
    settings = resolve_cors_settings("http://localhost:5173,*")
    assert settings.allow_origins == ["*"]
    assert settings.allow_credentials is False


def test_credentials_and_wildcard_are_never_combined():
    for raw in (None, "*", "http://a,*", "null", "http://a,http://b"):
        settings = resolve_cors_settings(raw)
        assert not (settings.allow_credentials and "*" in settings.allow_origins)


# --- the resolved policy actually works through Starlette ------------------

def _client(raw):
    settings = resolve_cors_settings(raw)
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allow_origins,
        allow_credentials=settings.allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/ping")
    def ping():
        return {"ok": True}

    return TestClient(app)


def test_null_origin_request_is_refused_by_default():
    resp = _client(None).get("/ping", headers={"Origin": "null"})
    assert resp.status_code == 200
    assert "access-control-allow-origin" not in resp.headers


def test_null_origin_request_is_allowed_by_explicit_opt_in():
    resp = _client("null").get("/ping", headers={"Origin": "null"})
    assert resp.headers["access-control-allow-origin"] == "null"


def test_dev_origin_request_is_allowed_by_default():
    resp = _client(None).get("/ping", headers={"Origin": "http://localhost:5173"})
    assert resp.headers["access-control-allow-origin"] == "http://localhost:5173"


@pytest.mark.parametrize("origin", TAURI_ORIGINS)
def test_packaged_tauri_origin_is_allowed_by_default(origin):
    resp = _client(None).get("/ping", headers={"Origin": origin})
    assert resp.headers["access-control-allow-origin"] == origin


def test_unlisted_origin_gets_no_allow_header():
    resp = _client(None).get("/ping", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in resp.headers


@pytest.mark.parametrize("raw,status", [(None, 400), ("null", 200)])
def test_preflight_from_null_origin_requires_opt_in(raw, status):
    resp = _client(raw).options(
        "/ping",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert resp.status_code == status
    if raw is None:
        assert "access-control-allow-origin" not in resp.headers
    else:
        assert resp.headers["access-control-allow-origin"] == "null"
