"""Save first, then make one bounded authentication probe. Never reflect bodies."""
import logging
from datetime import UTC, datetime

import requests
from fastapi import HTTPException

from app.infra import env_sources
from app.infra.secrets import (
    SECRET_ATTRS, SecretLockedError, SecretUnreadableError, apply_to_config,
)

logger = logging.getLogger(__name__)


def verify(config, name: str) -> tuple[bool, str | None]:
    """(verified, permanent rejection). Transient failures never change state."""
    try:
        if name == "KROBI_GENIUS_API_KEY":
            # Search works for client-only tokens, unlike /account (user scope).
            response = requests.get("https://api.genius.com/search", params={"q": "Krobi"},
                                    headers={"Authorization": f"Bearer {config.genius_api_key}"}, timeout=5)
            if response.status_code in (401, 403):
                return True, "genius-auth-rejected"
        elif name.startswith("SPOTIFY_"):
            if not config.spotify_client_id or not config.spotify_client_secret:
                return False, None
            data = {"grant_type": "client_credentials"}
            if name == "SPOTIFY_REFRESH_TOKEN":
                data = {"grant_type": "refresh_token", "refresh_token": config.spotify_refresh_token}
            response = requests.post("https://accounts.spotify.com/api/token", data=data,
                                     auth=(config.spotify_client_id, config.spotify_client_secret), timeout=5)
            if response.status_code in (400, 401, 403):
                body = response.json()
                error = body.get("error") if isinstance(body, dict) else None
                if error in ("invalid_client", "invalid_grant"):
                    return True, error
            if name == "SPOTIFY_REFRESH_TOKEN" and 200 <= response.status_code < 300:
                body = response.json()
                rotated = body.get("refresh_token") if isinstance(body, dict) else None
                if isinstance(rotated, str) and rotated:
                    config.secrets.put(name, rotated)
                    config.spotify_refresh_token = rotated
        else:
            return False, None  # A local household token has no remote verifier.
        return 200 <= response.status_code < 300, None
    except (requests.RequestException, ValueError):
        return False, None


def change(config, changes: dict[str, str | None], *, actor: str) -> None:
    """Shared by the new API and compatibility routes; no bypass for old UIs."""
    with env_sources.SETTINGS_LOCK:
        store = config.secrets
        try:
            for name in changes:
                if name not in SECRET_ATTRS:
                    raise HTTPException(404, {"code": "unknown-secret"})
                store.check_writable(name)
            changed = store.update(changes)
            apply_to_config(config)
            # A Spotify pair is verified by one request, including the legacy
            # route which still sends both fields in a single operation.
            probed_spotify = False
            for name in changed:
                value = changes[name]
                logger.info("Secret %s %s by %s at %s", name, "removed" if value is None else "saved",
                            actor, datetime.now(UTC).isoformat())
                if value is None:
                    continue
                if name in ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"):
                    if probed_spotify:
                        continue
                    probed_spotify = True
                verified, reason = verify(config, name)
                if verified:
                    targets = [n for n in changed if n in ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET")
                               and changes[n] is not None] if name in ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET") else [name]
                    for target in targets:
                        store.mark_verified(target, reason=reason)
        except SecretLockedError as error:
            raise HTTPException(409, error.details) from None
        except SecretUnreadableError as error:
            raise HTTPException(409, error.details) from None
        except OSError:
            raise HTTPException(500, {"code": "write-failed"}) from None
