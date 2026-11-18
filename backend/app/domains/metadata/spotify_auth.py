"""Spotify Authorization Code (user-login) OAuth flow + token management.

Why this exists: as of Spotify's Feb/Mar 2026 Web API changes, the Client
Credentials flow can no longer read playlist items ("Valid user authentication
required"). Reading a user's playlists now requires a *user* access token from
the Authorization Code flow. This holds the refresh token (persisted in
the nest's secret store) and mints short-lived access tokens on demand.
"""
import logging
import secrets
import time
from urllib.parse import urlencode

import requests

from app.config import ConfigManager

SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative"
_AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
_TOKEN_URL = "https://accounts.spotify.com/api/token"


class SpotifyAuth:
    """Manages the Spotify user-login OAuth flow and access-token refresh."""

    def __init__(self, config: ConfigManager, logger: logging.Logger):
        self.config = config
        self.logger = logger
        self._access_token: str | None = None
        self._access_expiry: float = 0.0
        self._pending_state: str | None = None

    # ---- status -------------------------------------------------------------
    def is_connected(self) -> bool:
        return bool(self.config.spotify_refresh_token)

    def is_configured(self) -> bool:
        return bool(self.config.spotify_client_id and self.config.spotify_client_secret)

    # ---- authorize / callback ----------------------------------------------
    def build_authorize_url(self) -> str:
        if not self.is_configured():
            raise RuntimeError("Spotify credentials not configured")
        state = secrets.token_urlsafe(16)
        self._pending_state = state
        params = {
            "client_id": self.config.spotify_client_id,
            "response_type": "code",
            "redirect_uri": self.config.spotify_redirect_uri,
            "scope": SPOTIFY_SCOPES,
            "state": state,
            "show_dialog": "false",
        }
        return f"{_AUTHORIZE_URL}?{urlencode(params)}"

    def exchange_code(self, code: str, state: str | None = None) -> None:
        """Exchange an authorization code for tokens; persist the refresh token."""
        # CSRF protection: the callback's `state` MUST match the value issued in
        # build_authorize_url. Consume it one-shot (so a callback can't be replayed)
        # and reject if it's missing OR mismatched — omitting `state` must NOT bypass
        # the check, otherwise an attacker can bind this app to their own account.
        expected = self._pending_state
        self._pending_state = None
        if not expected or not state or not secrets.compare_digest(state, expected):
            raise RuntimeError("OAuth state mismatch — possible CSRF, aborting")
        self.config.secrets.check_writable("SPOTIFY_REFRESH_TOKEN")
        resp = requests.post(
            _TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.config.spotify_redirect_uri,
            },
            auth=(self.config.spotify_client_id, self.config.spotify_client_secret),
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        refresh = data.get("refresh_token")
        if not refresh:
            raise RuntimeError("Spotify did not return a refresh token")
        self._persist_refresh_token(refresh)
        self.config.spotify_refresh_token = refresh
        self._access_token = data.get("access_token")
        self._access_expiry = time.time() + int(data.get("expires_in", 3600)) - 60
        self.logger.info("Spotify account connected (refresh token stored)")

    # ---- token use ----------------------------------------------------------
    def get_access_token(self) -> str:
        """Return a valid user access token, refreshing it if needed."""
        if self._access_token and time.time() < self._access_expiry:
            return self._access_token
        refresh = self.config.spotify_refresh_token
        if not refresh:
            raise RuntimeError(
                "Spotify account not connected. Connect it in Settings "
                "(Spotify now requires user login to read playlists)."
            )
        resp = requests.post(
            _TOKEN_URL,
            data={"grant_type": "refresh_token", "refresh_token": refresh},
            auth=(self.config.spotify_client_id, self.config.spotify_client_secret),
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_token = data.get("access_token")
        self._access_expiry = time.time() + int(data.get("expires_in", 3600)) - 60
        # Spotify may rotate the refresh token.
        if data.get("refresh_token"):
            self._persist_refresh_token(data["refresh_token"])
            self.config.spotify_refresh_token = data["refresh_token"]
        self.logger.info("Spotify user access token refreshed")
        return self._access_token

    def disconnect(self) -> None:
        self._persist_refresh_token("")
        self.config.spotify_refresh_token = None
        self._access_token = None
        self._access_expiry = 0.0
        self.logger.info("Spotify account disconnected")

    # ---- persistence --------------------------------------------------------
    def _persist_refresh_token(self, token: str) -> None:
        # The exchange/refresh call has already verified this value. Never make
        # an app copy of an operator-owned refresh token, including rotation.
        if token:
            self.config.secrets.put("SPOTIFY_REFRESH_TOKEN", token)
            self.config.secrets.mark_verified("SPOTIFY_REFRESH_TOKEN")
        else:
            self.config.secrets.delete("SPOTIFY_REFRESH_TOKEN")
