"""Request authentication through the real HTTP gate.

Cover loopback, remote, configured-secret and explicit public access.
A configured secret is required for every client.
See docs/security.md#request-authentication.
"""
import pytest
from fastapi.testclient import TestClient

from app.domains.accounts import auth
from app.domains.system import routes
from app.main import app
from app.infra import env_sources

TOKEN = "s3cret-shared-token"
WRONG = "s3cret-shared-tokeM"  # same length: exercises compare_digest, not a length check

# A path that exists on a gated router and needs no service mocking.
GATED_PATH = "/api/get-basedir"


@pytest.fixture
def config(monkeypatch, tmp_path):
    """The live ConfigManager, restored after each test."""
    cfg = app.state.config
    monkeypatch.setattr(cfg, "credentials_dir", tmp_path / "credentials")
    monkeypatch.setattr(env_sources, "ENV_KEYS", env_sources.ENV_KEYS - {"KROBI_MUSIC_DIR"})
    monkeypatch.setattr(env_sources, "APP_KEYS", set())
    # base_music_dir is included because /api/reset-basedir genuinely repoints it
    # on the shared app state, and leaking that into another test file would be a
    # miserable thing to debug.
    before = (
        cfg.api_token,
        cfg.allow_unauthenticated_remote,
        cfg.allow_remote_local_actions,
        cfg.base_music_dir,
    )
    yield cfg
    (
        cfg.api_token,
        cfg.allow_unauthenticated_remote,
        cfg.allow_remote_local_actions,
        cfg.base_music_dir,
    ) = before


@pytest.fixture(autouse=True)
def _reset_warning_state():
    # The "log this once" set is module state; clearing it keeps tests independent.
    auth._warned.clear()


def local_client() -> TestClient:
    """Client that looks like the desktop app: loopback peer (see conftest)."""
    return TestClient(app)


def remote_client() -> TestClient:
    """Client that looks like another machine on the LAN."""
    return TestClient(app, client=("192.0.2.42", 51000))


class TestNoTokenConfigured:
    """Backwards compatibility: the desktop app must not notice this feature."""

    def test_local_request_without_token_succeeds(self, config):
        config.api_token = None
        assert local_client().get(GATED_PATH).status_code == 200

    def test_local_request_still_succeeds_on_a_write_route(self, config):
        config.api_token = None
        assert local_client().get("/api/get-default-basedir").status_code == 200

    def test_remote_request_is_refused(self, config):
        config.api_token = None
        config.allow_unauthenticated_remote = False
        response = remote_client().get(GATED_PATH)
        assert response.status_code == 401
        # The message has to name the way out, or the operator is left guessing.
        assert "KROBI_API_TOKEN" in response.json()["detail"]

    def test_remote_request_allowed_by_explicit_opt_out(self, config):
        config.api_token = None
        config.allow_unauthenticated_remote = True
        assert remote_client().get(GATED_PATH).status_code == 200

    @pytest.mark.parametrize("origin", ["null", "https://attacker.example", ""])
    @pytest.mark.parametrize("remote_opt_out", [False, True])
    def test_browser_origin_cannot_inherit_local_owner(self, config, origin, remote_opt_out):
        config.api_token = None
        config.allow_unauthenticated_remote = remote_opt_out
        client = local_client()
        headers = {"Origin": origin}
        read = client.get("/api/users", headers=headers)
        write = client.post("/api/users", headers=headers, data={"label": "Untrusted"})
        for response in (read, write):
            assert response.status_code == 401
            assert response.json() == {"detail": "Missing API token."}
            assert response.headers["WWW-Authenticate"] == "Bearer"

    def test_cross_site_fetch_without_origin_cannot_inherit_local_owner(self, config):
        config.api_token = None
        response = local_client().post("/api/users", headers={"Sec-Fetch-Site": "cross-site"},
                                       data={"label": "Untrusted"})
        assert response.status_code == 401
        assert response.json() == {"detail": "Missing API token."}

    @pytest.mark.parametrize("origin", ["http://localhost:5173", "tauri://localhost"])
    def test_allowed_origin_keeps_owner_access_across_sites(self, config, origin):
        # A browser cannot forge Origin, and these pages are cross-site to the
        # loopback API by definition.
        config.api_token = None
        headers = {"Sec-Fetch-Site": "cross-site", "Origin": origin}
        assert local_client().get("/api/users", headers=headers).status_code == 200

    @pytest.mark.parametrize("origin", [
        None, "http://localhost:5173", "http://127.0.0.1:5173",
        "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost",
    ])
    def test_desktop_and_dev_origins_keep_owner_access(self, config, origin):
        config.api_token = None
        headers = {} if origin is None else {"Origin": origin}
        assert local_client().get("/api/users", headers=headers).status_code == 200

    def test_explicit_cors_origins_control_local_owner(self, config, monkeypatch):
        config.api_token = None
        monkeypatch.setattr(app.state, "cors_origins", ["null", "https://trusted.example"], raising=False)
        for origin in ("null", "https://trusted.example"):
            assert local_client().get("/api/users", headers={"Origin": origin}).status_code == 200
        assert local_client().get("/api/users", headers={"Origin": "http://localhost:5173"}).status_code == 401

    def test_wildcard_cors_does_not_grant_local_owner(self, config, monkeypatch):
        config.api_token = None
        monkeypatch.setattr(app.state, "cors_origins", ["*"], raising=False)
        assert local_client().get("/api/users", headers={"Origin": "https://attacker.example"}).status_code == 401


class TestTokenConfigured:
    def test_missing_token_is_refused(self, config):
        config.api_token = TOKEN
        response = local_client().get(GATED_PATH)
        assert response.status_code == 401
        assert response.headers["WWW-Authenticate"] == "Bearer"

    def test_wrong_token_is_refused(self, config):
        config.api_token = TOKEN
        response = local_client().get(GATED_PATH, headers={"Authorization": f"Bearer {WRONG}"})
        assert response.status_code == 401

    def test_correct_bearer_token_passes(self, config):
        config.api_token = TOKEN
        response = local_client().get(GATED_PATH, headers={"Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 200

    def test_correct_token_in_custom_header_passes(self, config):
        config.api_token = TOKEN
        response = local_client().get(GATED_PATH, headers={auth.TOKEN_HEADER: TOKEN})
        assert response.status_code == 200

    def test_correct_token_in_query_param_passes(self, config):
        """The EventSource / <audio src> path: no headers available."""
        config.api_token = TOKEN
        response = local_client().get(f"{GATED_PATH}?{auth.TOKEN_QUERY_PARAM}={TOKEN}")
        assert response.status_code == 200

    def test_wrong_token_in_query_param_is_refused(self, config):
        config.api_token = TOKEN
        response = local_client().get(f"{GATED_PATH}?{auth.TOKEN_QUERY_PARAM}={WRONG}")
        assert response.status_code == 401

    def test_loopback_does_not_bypass_a_configured_token(self, config):
        """No local exemption once a token exists — see the module docstring."""
        config.api_token = TOKEN
        assert local_client().get(GATED_PATH).status_code == 401

    def test_remote_caller_with_the_token_passes(self, config):
        config.api_token = TOKEN
        response = remote_client().get(GATED_PATH, headers={"Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 200

    def test_empty_configured_token_means_no_auth(self):
        """An empty KROBI_API_TOKEN= line in .env must not enable auth-with-empty-secret."""
        from app.config import ConfigManager

        cfg = ConfigManager(
            data_root=app.state.config.data_root,
            base_music_dir=app.state.config.base_music_dir,
            playlist_dir=app.state.config.playlist_dir,
            temp_dir=app.state.config.temp_dir,
            log_dir=app.state.config.log_dir,
            credentials_dir=app.state.config.credentials_dir,
            api_token="   ",
        )
        assert cfg.api_token is None


class TestPublicRoutes:
    """These must answer whatever the configuration says."""

    @pytest.mark.parametrize("token", [None, TOKEN])
    def test_health_is_always_reachable(self, config, token):
        config.api_token = token
        response = local_client().get("/api/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    @pytest.mark.parametrize("token", [None, TOKEN])
    def test_health_is_reachable_remotely(self, config, token):
        """Electron polls this over the network before it opens its window."""
        config.api_token = token
        assert remote_client().get("/api/health").status_code == 200

    @pytest.mark.parametrize("token", [None, TOKEN])
    def test_root_is_always_reachable(self, config, token):
        """The container HEALTHCHECK probes '/'. It is declared on the app, not a router."""
        config.api_token = token
        assert remote_client().get("/").status_code == 200

    def test_spotify_callback_is_public(self, config):
        """Spotify's redirect arrives from a browser that cannot carry the token."""
        config.api_token = TOKEN
        # No code and no error -> the handler's own "missing code" page, not a 401.
        response = remote_client().get("/api/spotify/callback")
        assert response.status_code == 200


class TestForwardedHeadersCannotForgeLoopback:
    """uvicorn runs with --forwarded-allow-ips '*' in the container and the unit.

    That means it rewrites the peer address from X-Forwarded-For sent by anyone,
    so a forwarded request must never count as local.
    """

    def test_spoofed_forwarded_for_does_not_unlock_the_api(self, config):
        config.api_token = None
        config.allow_unauthenticated_remote = False
        response = remote_client().get(GATED_PATH, headers={"X-Forwarded-For": "127.0.0.1"})
        assert response.status_code == 401

    def test_a_forwarded_loopback_request_is_not_local_either(self, config):
        config.api_token = None
        config.allow_unauthenticated_remote = False
        # Peer really is 127.0.0.1 (a same-box reverse proxy), but the header says
        # the request originated elsewhere, so it is not this machine's own call.
        response = local_client().get(GATED_PATH, headers={"X-Forwarded-For": "10.0.0.9"})
        assert response.status_code == 401


class TestLocallyMeaningfulEndpoints:
    """Endpoints that act on the machine running the backend (Part 3)."""

    @pytest.mark.parametrize(
        "method,path,payload",
        [
            ("post", "/api/set-basedir", {"basedir": "/tmp"}),
            ("post", "/api/reset-basedir", None),
            ("post", "/api/open-file", {"path": "/tmp/x.mp3"}),
        ],
    )
    def test_refused_for_a_remote_caller_even_with_a_valid_token(
        self, config, method, path, payload
    ):
        config.api_token = TOKEN
        config.allow_remote_local_actions = False
        response = getattr(remote_client(), method)(
            path, json=payload, headers={"Authorization": f"Bearer {TOKEN}"}
        )
        assert response.status_code == 403
        assert "KROBI_ALLOW_REMOTE_LOCAL_ACTIONS" in response.json()["detail"]

    def test_token_is_still_checked_before_the_local_gate(self, config):
        config.api_token = TOKEN
        response = remote_client().post("/api/reset-basedir")
        assert response.status_code == 401

    def test_opt_in_allows_a_remote_caller(self, config, monkeypatch):
        config.api_token = TOKEN
        config.allow_remote_local_actions = True
        # The integration fixture deliberately keeps its library in pytest's
        # temp directory. Point the path-safety boundary at that synthetic home
        # so this test isolates the remote-action opt-in instead of failing the
        # separate production-home-directory guard.
        monkeypatch.setattr(routes, "_ALLOWED_BASEDIR_PARENT", config.base_music_dir.parent)
        response = remote_client().post(
            "/api/set-basedir",
            json={"basedir": str(config.base_music_dir)},
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        assert response.status_code == 200

    def test_local_caller_is_unaffected(self, config):
        config.api_token = None
        assert local_client().post("/api/reset-basedir").status_code == 200


class TestHelpers:
    def test_is_public_route_does_not_prefix_match_health(self):
        assert auth.is_public_route("GET", "/api/health")
        assert not auth.is_public_route("GET", "/api/health-secrets")
