"""Accounts an owner creates can sign in by name from the start.

The username and password are optional on the wire and must come together; the same rules
as the first-run claim apply, and the password never appears in a response or a log line.
See docs/security.md.
"""
import logging

from fastapi.testclient import TestClient

from app.main import app

PASSWORD = "a-long-enough-password"


def client():
    return TestClient(app, client=("192.0.2.42", 51000))


def headers(token):
    return {"Authorization": f"Bearer {token}"}


def owner(store):
    record, token = store.mint("Owner", "owner")
    return record, token


def test_created_member_signs_in_with_its_username_and_password(accounts, caplog):
    _, token = owner(accounts)
    with caplog.at_level(logging.DEBUG):
        created = client().post("/api/users", headers=headers(token),
                                json={"label": "Ana", "role": "member", "username": "ana", "password": PASSWORD})
    assert created.status_code == 201
    assert PASSWORD not in created.text
    assert PASSWORD not in caplog.text
    # The listing row stays five keys (shipped clients decode it strictly); /api/me carries the name.
    assert "username" not in created.json()["user"]
    signed_in = client().post("/api/login", json={"username": "ana", "password": PASSWORD})
    assert signed_in.status_code == 201
    assert PASSWORD not in signed_in.text
    me = client().get("/api/me", headers=headers(signed_in.json()["token"])).json()
    assert me["isOwner"] is False and me["username"] == "ana"


def test_username_and_password_come_together(accounts):
    _, token = owner(accounts)
    for partial in ({"username": "ana"}, {"password": PASSWORD}):
        response = client().post("/api/users", headers=headers(token), json={"label": "Ana", **partial})
        assert response.status_code == 422
        assert "together" in response.json()["detail"]
    assert client().post("/api/users", headers=headers(token), json={"label": "Ana"}).status_code == 201


def test_duplicate_username_is_409_and_weak_password_is_422(accounts):
    _, token = owner(accounts)
    first = {"label": "Ana", "username": "ana", "password": PASSWORD}
    assert client().post("/api/users", headers=headers(token), json=first).status_code == 201
    duplicate = client().post("/api/users", headers=headers(token), json={**first, "label": "Other Ana"})
    assert duplicate.status_code == 409
    weak = client().post("/api/users", headers=headers(token), json={"label": "Bo", "username": "bo", "password": "short"})
    assert weak.status_code == 422
    assert "short" not in weak.text


def test_a_member_cannot_create_accounts_or_reset_them(accounts):
    _, owner_token = owner(accounts)
    member = client().post("/api/users", headers=headers(owner_token),
                           json={"label": "Ana", "username": "ana", "password": PASSWORD}).json()
    member_token = member["token"]
    assert client().post("/api/users", headers=headers(member_token),
                         json={"label": "Eve", "username": "eve", "password": PASSWORD}).status_code == 403
    other, _ = accounts.mint("Other", "member")
    assert client().post(f"/api/users/{other.user_id}/password", headers=headers(member_token),
                         json={"newPassword": PASSWORD, "username": "taken-over"}).status_code == 403


def test_owner_gives_a_token_only_account_a_username_and_password_in_one_call(accounts, caplog):
    _, token = owner(accounts)
    no_name, _ = accounts.mint("Test", "member")
    with caplog.at_level(logging.DEBUG):
        response = client().post(f"/api/users/{no_name.user_id}/password", headers=headers(token),
                                 json={"newPassword": PASSWORD, "username": "test-member"})
    assert response.status_code == 200
    assert PASSWORD not in response.text and PASSWORD not in caplog.text
    assert accounts.get_user(no_name.user_id).username == "test-member"
    assert client().post("/api/login", json={"username": "test-member", "password": PASSWORD}).status_code == 201


def test_reset_keeps_an_existing_username_and_refuses_a_taken_one(accounts):
    _, token = owner(accounts)
    named = client().post("/api/users", headers=headers(token),
                          json={"label": "Ana", "username": "ana", "password": PASSWORD}).json()["user"]
    assert client().post(f"/api/users/{named['id']}/password", headers=headers(token),
                         json={"newPassword": "another-long-password", "username": "renamed"}).status_code == 200
    assert accounts.get_user(named["id"]).username == "ana"
    no_name, _ = accounts.mint("Test", "member")
    assert client().post(f"/api/users/{no_name.user_id}/password", headers=headers(token),
                         json={"newPassword": PASSWORD, "username": "ana"}).status_code == 409
    assert client().post(f"/api/users/{no_name.user_id}/password", headers=headers(token),
                         json={"newPassword": PASSWORD}).status_code == 409


def test_an_owner_sees_whether_an_account_has_a_username_before_resetting(accounts):
    _, token = owner(accounts)
    no_name, member_token = accounts.mint("Test", "member")
    named = client().post("/api/users", headers=headers(token),
                          json={"label": "Ana", "username": "ana", "password": PASSWORD}).json()["user"]
    assert client().get(f"/api/users/{no_name.user_id}/sign-in", headers=headers(token)).json() == {"username": None, "hasPassword": False}
    assert client().get(f"/api/users/{named['id']}/sign-in", headers=headers(token)).json() == {"username": "ana", "hasPassword": True}
    assert client().get("/api/users/nobody/sign-in", headers=headers(token)).status_code == 404
    assert client().get(f"/api/users/{named['id']}/sign-in", headers=headers(member_token)).status_code == 403
