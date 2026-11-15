"""Shared identity ports, authorization gates and compatibility aliases.

Preserve caller isolation, principal state and alias identity.
Account gates must distinguish synthetic principals from account rows.
See docs/security.md#request-authentication.
"""
import importlib
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.infra.identity import (
    Principal, current_principal, get_config, get_token_resolver,
    require_api_token, require_helper,
)


@pytest.mark.parametrize("module,export", [
    ("logging", "LoggerConfig"),
    ("files", "write_secret_lines"),
    ("progress", "ProgressTracker"),
    ("nest_helper", "_parse"),
])
def test_plugin_alias_shares_exports_and_monkeypatches(module, export, monkeypatch):
    legacy = importlib.import_module(f"app.core.{module}")
    replacement = importlib.import_module(f"app.domains.helpers.{module}" if module == "nest_helper" else f"app.infra.{module}")
    assert getattr(legacy, export) is getattr(replacement, export)
    marker = object()
    monkeypatch.setattr(legacy, export, marker)
    assert getattr(replacement, export) is marker


def test_accounts_reexports_preserve_principal_and_dependency_identity():
    from app.domains.accounts import auth, identity
    from app.domains.accounts.routes import require_account
    from app.infra import identity as infra
    from app import dependencies

    assert identity.Principal is infra.Principal
    for name in ("ANONYMOUS", "LOCAL_OWNER", "LEGACY_OWNER", "UNKNOWN", "SENTINEL_PRINCIPALS"):
        assert getattr(identity, name) is getattr(infra, name)
    assert auth.current_principal is current_principal
    assert auth.require_owner is infra.require_owner
    assert require_account is infra.require_account
    assert dependencies.get_token_store is get_token_resolver
    assert dependencies.get_config is get_config


def test_auth_uses_each_apps_registered_port_and_honors_dependency_overrides():
    """No accounts implementation is needed to resolve and authorize a helper."""
    def make_app(label):
        app = FastAPI()
        owner = Principal(label, label, "owner", "helper-device")
        helper = SimpleNamespace(helper=True)
        account = SimpleNamespace(role="owner", device=lambda device_id: helper)
        resolver = SimpleNamespace(
            resolve=lambda token: owner if token == "valid" else None,
            get_user=lambda user_id: account if user_id == label else None,
        )
        app.state.config = SimpleNamespace(api_token="shared-secret")
        app.state.identity_resolver = lambda request: resolver

        @app.get("/helper", dependencies=[Depends(require_api_token)])
        def read_helper(principal=Depends(require_helper)):
            return principal.user_id

        return app

    first, second = make_app("first"), make_app("second")
    headers = {"Authorization": "Bearer valid"}
    with TestClient(first) as client:
        assert client.get("/helper", headers=headers).json() == "first"
        with TestClient(second) as other:
            assert other.get("/helper", headers=headers).json() == "second"
        assert client.get("/helper", headers=headers).json() == "first"
        first.dependency_overrides[get_token_resolver] = lambda: SimpleNamespace(resolve=lambda token: None)
        assert client.get("/helper", headers=headers).status_code == 401
