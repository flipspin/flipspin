"""Tests for the CORS policy resolution used by app.main.

The backend is meant to be reachable from a Tauri client on another machine.
Two renderer code paths talk to it directly from a browser context (the SSE
progress EventSource and LibraryContext's raw fetches), and a packaged renderer
loaded from file:// sends the literal header ``Origin: null`` — so the default
policy has to accept it, and must never combine ``*`` with credentials.
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
        "null",
    ]
    assert settings.allow_credentials is True
    assert settings.warnings == []


def test_default_accepts_packaged_origins_and_legacy_file_origin():
    settings = resolve_cors_settings(None)
    assert all(origin in settings.allow_origins for origin in TAURI_ORIGINS)
    assert NULL_ORIGIN in resolve_cors_settings(None).allow_origins


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


def test_null_origin_request_is_allowed_by_default():
    resp = _client(None).get("/ping", headers={"Origin": "null"})
    assert resp.status_code == 200
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


def test_preflight_from_null_origin_succeeds():
    resp = _client(None).options(
        "/ping",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "null"
