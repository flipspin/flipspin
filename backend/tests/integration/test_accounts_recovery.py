"""Password recovery, device authorization and first-run routes.

Exercise real authentication while preserving existing device access.
Use isolated accounts for reset and sign-in-code decisions.
See docs/security.md#recovery.
"""
import io
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.__main__ import main
from app.domains.accounts.auth import is_public_route
from app.domains.accounts.identity import TokenStore
from app.domains.accounts.passwords import verify_password
from app.main import app


def client():
    return TestClient(app, client=("192.0.2.42", 51000))


def headers(token):
    return {"Authorization": f"Bearer {token}"}


def user(store, name="ana", role="member"):
    record, token = store.mint(name, role)
    store.set_username(record.user_id, name)
    store.set_password(record.user_id, "original-password")
    return record, token


def request_code():
    response = TestClient(app, client=("192.168.1.20", 51000)).post("/api/sign-in-code", json={"deviceLabel": "TV de la sala"})
    assert response.status_code == 201
    return response.json()


def poll(ticket):
    return client().post("/api/sign-in-code/poll", json={"secret": ticket["secret"]})


def approve(ticket, token):
    return client().post("/api/me/sign-in-code", json={"code": ticket["code"]}, headers=headers(token))


@pytest.fixture
def code_clock(accounts):
    now = [1000.0]
    app.state.container.get_sign_in_codes().clock = lambda: now[0]
    return now


class TestPasswordRecovery:
    def test_cli_prompts_twice_and_keeps_devices(self, accounts, monkeypatch, capsys):
        account, token = user(accounts)
        monkeypatch.setenv("KROBI_USERS_FILE", str(accounts.path))
        prompts = []

        def password(prompt):
            prompts.append(prompt)
            return "brand-new-password"

        monkeypatch.setattr("getpass.getpass", password)
        main(["reset-password", "ANA"])
        output = capsys.readouterr()
        assert "ana (ana)" in output.out
        assert "brand-new-password" not in output.out + output.err
        assert len(prompts) == 2
        # The already-running store must notice the CLI's external write.
        assert verify_password("brand-new-password", accounts.get_user(account.user_id).password_hash)
        reloaded = TokenStore(accounts.path, logging.getLogger(__name__))
        assert verify_password("brand-new-password", reloaded.get_user(account.user_id).password_hash)
        assert reloaded.resolve(token).user_id == account.user_id

    def test_cli_stdin(self, accounts, monkeypatch, capsys):
        account, _ = user(accounts)
        monkeypatch.setenv("KROBI_USERS_FILE", str(accounts.path))
        monkeypatch.setattr("sys.stdin", io.StringIO("stdin-password\n"))
        main(["reset-password", "ana", "--password-stdin"])
        output = capsys.readouterr()
        assert "stdin-password" not in output.out + output.err
        reloaded = TokenStore(accounts.path, logging.getLogger(__name__))
        assert verify_password("stdin-password", reloaded.get_user(account.user_id).password_hash)

    def test_unknown_cli_user_is_refused_before_prompt(self, accounts, monkeypatch, capsys):
        monkeypatch.setenv("KROBI_USERS_FILE", str(accounts.path))
        monkeypatch.setattr("getpass.getpass", lambda _: pytest.fail("must not prompt"))
        with pytest.raises(SystemExit) as error:
            main(["reset-password", "nobody"])
        assert error.value.code == 1
        assert "Unknown username" in capsys.readouterr().err

    def test_cli_mismatch_preserves_password(self, accounts, monkeypatch):
        account, _ = user(accounts)
        monkeypatch.setenv("KROBI_USERS_FILE", str(accounts.path))
        values = iter(["first-password", "different-password"])
        monkeypatch.setattr("getpass.getpass", lambda _: next(values))
        with pytest.raises(SystemExit):
            main(["reset-password", "ana"])
        assert verify_password("original-password", accounts.get_user(account.user_id).password_hash)

    def test_owner_resets_other_account_without_revoking_devices(self, accounts):
        _, owner = user(accounts, "owner", "owner")
        account, member = user(accounts)
        response = client().post(f"/api/users/{account.user_id}/password",
                                 json={"newPassword": "replacement-password"}, headers=headers(owner))
        assert response.status_code == 200
        assert response.json() == {"success": True, "otherDevicesSignedOut": False, "deviceCount": 1}
        assert verify_password("replacement-password", accounts.get_user(account.user_id).password_hash)
        assert accounts.resolve(member).user_id == account.user_id
        assert "replacement-password" not in response.text

    def test_member_cannot_reset_others(self, accounts):
        owner, _ = user(accounts, "owner", "owner")
        _, member = user(accounts)
        assert client().post(f"/api/users/{owner.user_id}/password", json={"newPassword": "replacement-password"},
                             headers=headers(member)).status_code == 403

    @pytest.mark.parametrize("sentinel", ["local", "shared", "anonymous"])
    def test_sentinels_cannot_reset(self, accounts, monkeypatch, sentinel):
        account, _ = user(accounts)
        caller = TestClient(app) if sentinel == "local" else client()
        auth = {}
        if sentinel == "shared":
            monkeypatch.setattr(app.state.config, "api_token", "shared")
            auth = headers("shared")
        if sentinel == "anonymous":
            monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        expected = 409
        assert caller.post(f"/api/users/{account.user_id}/password", json={"newPassword": "replacement-password"},
                           headers=auth).status_code == expected

    def test_self_unknown_and_no_username(self, accounts):
        owner, token = user(accounts, "owner", "owner")
        no_name, _ = accounts.mint("No name", "member")
        for target, status in [(owner.user_id, 409), ("missing", 404), (no_name.user_id, 409)]:
            assert client().post(f"/api/users/{target}/password", json={"newPassword": "replacement-password"},
                                 headers=headers(token)).status_code == status
        assert client().post(f"/api/users/{no_name.user_id}/password", json={"newPassword": "short"},
                             headers=headers(token)).status_code == 422


class TestSignInCode:
    def test_request_and_exactly_once_redemption(self, accounts, code_clock):
        account, token = user(accounts)
        ticket = request_code()
        assert ticket["expiresIn"] == 600 and ticket["pollInterval"] == 2
        assert len(ticket["secret"]) >= 43
        assert poll(ticket).json() == {"credential": None}
        assert approve(ticket, token).json() == {"success": True}
        assert len(accounts.get_user(account.user_id).devices) == 1
        code_clock[0] += 2
        credential = poll(ticket).json()["credential"]
        assert credential["device"]["label"] == "TV de la sala"
        assert accounts.resolve(credential["token"]).user_id == account.user_id
        assert poll(ticket).json() == {"credential": None}
        assert approve(ticket, token).status_code == 404
        stored = accounts.path.read_text()
        assert ticket["secret"] not in stored and credential["token"] not in stored

    def test_wrong_code_secret_and_normalization(self, accounts, code_clock):
        _, token = user(accounts)
        ticket = request_code()
        assert approve({"code": "XXXXXX"}, token).status_code == 404
        assert poll({"secret": "wrong-secret"}).json() == {"credential": None}
        formatted = ticket["code"][:3].lower() + "-" + ticket["code"][3:].lower()
        assert approve({"code": formatted}, token).status_code == 200
        assert poll({"secret": "wrong-secret"}).json() == {"credential": None}
        assert poll(ticket).json()["credential"] is not None

    @pytest.mark.parametrize("approved", [False, True])
    def test_expired_yields_nothing(self, accounts, code_clock, approved):
        account, token = user(accounts)
        ticket = request_code()
        if approved:
            assert approve(ticket, token).status_code == 200
        code_clock[0] += 600
        assert poll(ticket).json() == {"credential": None}
        assert approve(ticket, token).status_code == 404
        assert len(accounts.get_user(account.user_id).devices) == 1

    def test_approval_is_real_account_only(self, accounts, code_clock, monkeypatch):
        ticket = request_code()
        assert approve(ticket, "invalid").status_code == 401
        assert TestClient(app).post("/api/me/sign-in-code", json={"code": ticket["code"]}).status_code == 409
        monkeypatch.setattr(app.state.config, "api_token", "shared")
        assert approve(ticket, "shared").status_code == 409
        monkeypatch.setattr(app.state.config, "api_token", None)
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        assert client().post("/api/me/sign-in-code", json={"code": ticket["code"]}).status_code == 409
        assert poll(ticket).json() == {"credential": None}
        assert is_public_route("POST", "/api/sign-in-code")
        assert is_public_route("POST", "/api/sign-in-code/poll")
        assert not is_public_route("POST", "/api/me/sign-in-code")
        assert client().get("/api/sign-in-code").status_code == 405

    def test_request_approval_and_poll_limits(self, accounts, code_clock):
        _, token = user(accounts)
        ticket = request_code()
        for _ in range(19):
            request_code()
        assert TestClient(app, client=("192.168.1.20", 51000)).post("/api/sign-in-code", json={"deviceLabel": "TV"}).status_code == 429
        for _ in range(10):
            assert approve({"code": "XXXXXX"}, token).status_code == 404
        assert approve(ticket, token).status_code == 429
        assert poll(ticket).status_code == 200
        assert poll(ticket).status_code == 429
        code_clock[0] += 60
        assert approve(ticket, token).status_code == 200
        assert poll(ticket).json()["credential"] is not None

    def test_two_concurrent_polls_mint_one_device(self, accounts, code_clock):
        account, token = user(accounts)
        ticket = request_code()
        approve(ticket, token)
        with ThreadPoolExecutor(max_workers=2) as pool:
            bodies = list(pool.map(lambda _: poll(ticket).json(), range(2)))
        assert sum(body["credential"] is not None for body in bodies) == 1
        assert len(accounts.get_user(account.user_id).devices) == 2

    def test_deleted_approver_cannot_mint(self, accounts, code_clock):
        accounts.mint("Owner", "owner")
        account, token = user(accounts)
        ticket = request_code()
        approve(ticket, token)
        accounts.revoke(account.user_id)
        assert poll(ticket).json() == {"credential": None}

    def test_shared_contract(self, accounts, code_clock):
        from app.domains.accounts import sign_in_code as rules
        contract = json.loads((Path(__file__).resolve().parents[3] / "contracts/sign-in-code.json").read_text())
        assert rules.ALPHABET == contract["alphabet"]
        assert rules.CODE_LENGTH == contract["length"]
        for _ in range(20):
            ticket = request_code()
            assert len(ticket["code"]) == contract["length"]
            assert set(ticket["code"]) <= set(contract["alphabet"])
        for case in contract["format"]:
            assert rules.normalize_code(case["input"]) == case["normalized"]


class TestOnboarded:
    def test_default_persists_across_devices_and_restarts(self, accounts):
        account, token = user(accounts)
        assert client().get("/api/me", headers=headers(token)).json()["onboarded"] is False
        assert client().post("/api/me/onboarded", headers=headers(token)).json() == {"onboarded": True}
        assert client().post("/api/me/onboarded", headers=headers(token)).json() == {"onboarded": True}
        _, _, second = accounts.add_device(account.user_id, "Other browser")
        assert client().get("/api/me", headers=headers(second)).json()["onboarded"] is True
        reloaded = TokenStore(accounts.path, logging.getLogger(__name__))
        assert reloaded.get_user(account.user_id).onboarded is True
        _, other_token = user(accounts, "other")
        assert client().get("/api/me", headers=headers(other_token)).json()["onboarded"] is False

    def test_sentinel_has_no_first_run_to_complete(self, accounts):
        assert TestClient(app).get("/api/me").json()["onboarded"] is False
        assert TestClient(app).post("/api/me/onboarded").status_code == 409
        assert client().post("/api/me/onboarded").status_code == 401


def test_cli_uses_server_dotenv_precedence(accounts, monkeypatch, tmp_path):
    account, _ = user(accounts)
    home = tmp_path / "dotenv-home"
    monkeypatch.setenv("FLIPSPIN_DATA_DIR", str(home))
    home.mkdir()
    (home / ".env").write_text(f"KROBI_USERS_FILE={accounts.path}\n")
    monkeypatch.setenv("KROBI_CREDENTIALS_DIR", str(home / "credentials"))
    monkeypatch.setenv("KROBI_USERS_FILE", "placeholder-for-cleanup")
    monkeypatch.delenv("KROBI_USERS_FILE")
    monkeypatch.setattr("sys.stdin", io.StringIO("dotenv-password\n"))
    main(["reset-password", "ana", "--password-stdin"])
    assert verify_password("dotenv-password", accounts.get_user(account.user_id).password_hash)
