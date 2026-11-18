"""Regression tests for the Spotify OAuth flow: CSRF state + token refresh.

Covers the CSRF fix in ``exchange_code`` (omitting/forging ``state`` must not
bind the app to an attacker's account) and the access-token refresh logic.
``requests.post`` is mocked, so no network is hit and no real ``.env`` outside
the test temp dir is touched.
"""
import logging
import time
from unittest.mock import MagicMock, patch

import pytest

from app.domains.metadata.spotify_auth import SpotifyAuth


def _make_auth(config):
    config.spotify_client_id = "cid"
    config.spotify_client_secret = "secret"
    return SpotifyAuth(config, logging.getLogger("test"))


def _token_response(**data):
    resp = MagicMock()
    resp.json.return_value = data
    resp.raise_for_status.return_value = None
    return resp


# --- CSRF state on exchange_code ---------------------------------------------

@patch("app.domains.metadata.spotify_auth.requests.post")
def test_exchange_code_rejects_missing_state(mock_post, config):
    auth = _make_auth(config)
    auth._pending_state = "ISSUED"
    with pytest.raises(RuntimeError, match="CSRF"):
        auth.exchange_code("authcode", None)
    mock_post.assert_not_called()  # never reaches the token endpoint


@patch("app.domains.metadata.spotify_auth.requests.post")
def test_exchange_code_rejects_mismatched_state(mock_post, config):
    auth = _make_auth(config)
    auth._pending_state = "ISSUED"
    with pytest.raises(RuntimeError, match="CSRF"):
        auth.exchange_code("authcode", "ATTACKER")
    mock_post.assert_not_called()


@patch("app.domains.metadata.spotify_auth.requests.post")
def test_exchange_code_rejects_when_no_state_was_issued(mock_post, config):
    auth = _make_auth(config)
    auth._pending_state = None  # e.g. backend restarted; nothing pending
    with pytest.raises(RuntimeError, match="CSRF"):
        auth.exchange_code("authcode", "anything")
    mock_post.assert_not_called()


@patch("app.domains.metadata.spotify_auth.requests.post")
def test_exchange_code_accepts_matching_state_and_persists_token(mock_post, config):
    mock_post.return_value = _token_response(
        access_token="AT", refresh_token="RT", expires_in=3600
    )
    auth = _make_auth(config)
    auth._pending_state = "GOOD"
    auth.exchange_code("authcode", "GOOD")
    mock_post.assert_called_once()
    assert config.spotify_refresh_token == "RT"
    assert auth._pending_state is None  # consumed one-shot


@patch("app.domains.metadata.spotify_auth.requests.post")
def test_exchange_code_state_is_single_use(mock_post, config):
    """A replayed callback reusing the now-consumed state must fail."""
    mock_post.return_value = _token_response(
        access_token="AT", refresh_token="RT", expires_in=3600
    )
    auth = _make_auth(config)
    auth._pending_state = "GOOD"
    auth.exchange_code("authcode", "GOOD")  # consumes the state
    with pytest.raises(RuntimeError, match="CSRF"):
        auth.exchange_code("authcode", "GOOD")


# --- access-token refresh -----------------------------------------------------

@patch("app.domains.metadata.spotify_auth.requests.post")
def test_get_access_token_returns_cached_before_expiry(mock_post, config):
    auth = _make_auth(config)
    auth._access_token = "CACHED"
    auth._access_expiry = time.time() + 1000
    assert auth.get_access_token() == "CACHED"
    mock_post.assert_not_called()


@patch("app.domains.metadata.spotify_auth.requests.post")
def test_get_access_token_refreshes_when_expired(mock_post, config):
    mock_post.return_value = _token_response(access_token="FRESH", expires_in=3600)
    auth = _make_auth(config)
    config.spotify_refresh_token = "RT"
    auth._access_token = "OLD"
    auth._access_expiry = time.time() - 10  # expired
    assert auth.get_access_token() == "FRESH"
    mock_post.assert_called_once()


@patch("app.domains.metadata.spotify_auth.requests.post")
def test_get_access_token_persists_rotated_refresh_token(mock_post, config):
    mock_post.return_value = _token_response(
        access_token="FRESH", refresh_token="ROTATED", expires_in=3600
    )
    auth = _make_auth(config)
    config.spotify_refresh_token = "OLD_RT"
    auth.get_access_token()
    assert config.spotify_refresh_token == "ROTATED"


def test_get_access_token_raises_when_not_connected(config):
    auth = _make_auth(config)
    config.spotify_refresh_token = None
    auth._access_token = None
    with pytest.raises(RuntimeError, match="not connected"):
        auth.get_access_token()
