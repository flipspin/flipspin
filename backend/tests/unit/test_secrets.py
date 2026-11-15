"""Secrets contract: private creation, lossless migration, locks and key loss."""
import json
import os
from hashlib import sha256
from unittest.mock import Mock

import pytest
from cryptography.fernet import Fernet

from app.config import REQUIRED_DIRS, STATE_PATHS, ConfigManager
from app.exceptions import ConfigurationError
from app.infra import env_sources, files
from app.infra.secrets import SECRET_ATTRS, SecretLockedError, SecretStore, SecretUnreadableError

GENIUS = "KROBI_GENIUS_API_KEY"


def vault(home, **kwargs):
    return SecretStore(home / "credentials", home / "instance.json", environment=kwargs.pop("environment", {}), **kwargs)


def test_every_credential_file_is_private_before_first_write(tmp_path, monkeypatch):
    observed = []
    fdopen = os.fdopen
    replace = os.replace
    mkstemp = files.tempfile.mkstemp
    private_fds = set()

    def creating(*args, **kwargs):
        fd, path = mkstemp(*args, **kwargs)
        if kwargs.get("dir") == str(tmp_path / "credentials"):
            assert os.fstat(fd).st_mode & 0o777 == 0o600
            private_fds.add(fd)
        else:
            private_fds.discard(fd)
        return fd, path

    def opening(fd, *args, **kwargs):
        # mkstemp creates 0600 even with a permissive umask, before fchmod/write.
        if fd in private_fds:
            observed.append(os.fstat(fd).st_mode & 0o777)
        return fdopen(fd, *args, **kwargs)

    def replacing(source, target):
        if str(tmp_path / "credentials") in str(target):
            assert os.stat(source).st_mode & 0o777 == 0o600
        return replace(source, target)

    monkeypatch.setattr(files.os, "fdopen", opening)
    monkeypatch.setattr(files.os, "replace", replacing)
    monkeypatch.setattr(files.tempfile, "mkstemp", creating)
    monkeypatch.setattr("pathlib.Path.chmod", Mock(side_effect=AssertionError("no chmod-after-write")))
    old_umask = os.umask(0)
    try:
        store = vault(tmp_path)
        store.put(GENIUS, "birth-private-secret")
        store.save_credentials("subsonic-app-passwords", {"device": "birth-private-password"})
    finally:
        os.umask(old_umask)
    assert observed and set(observed) == {0o600}
    assert {p.name for p in store.directory.iterdir()} == {".key", "secrets.json"}
    assert all(p.stat().st_mode & 0o777 == 0o600 for p in store.directory.iterdir())


def legacy(home):
    directory = home / "credentials"
    directory.mkdir()
    key = Fernet.generate_key()
    (directory / ".key").write_bytes(key)
    (directory / "genius.json").write_text(json.dumps({"apiKey": "legacy-genius"}))
    passwords = {"device-1": "legacy-app-password", "device-2": "second-password"}
    (directory / "subsonic-app-passwords.enc").write_bytes(Fernet(key).encrypt(json.dumps(passwords).encode()))
    (directory / "spotify.enc").write_bytes(Fernet(key).encrypt(b'{"token":"other-legacy-token"}'))
    settings = '# preserve me\nKROBI_MAX_CONCURRENT_DOWNLOADS=4\nKROBI_YTDLP_COOKIES_FROM_BROWSER=firefox\nKROBI_YTDLP_COOKIES_FILE=/tmp/cookies.txt\n\n'
    settings += 'export KROBI_API_TOKEN="legacy-api-token"\n'
    values = {"SPOTIFY_CLIENT_ID": "legacy-client", "SPOTIFY_CLIENT_SECRET": "legacy-spotify-secret",
              "SPOTIFY_REFRESH_TOKEN": "legacy-refresh"}
    (home / ".env").write_text(settings + ''.join(f'export {k}="{v}"\n' for k, v in values.items()))
    return key, passwords, settings, values


@pytest.mark.parametrize("external_key", [False, True])
def test_migration_all_formats_identical_cleanup_and_idempotent(tmp_path, external_key):
    key, passwords, settings, values = legacy(tmp_path)
    environment = {}
    if external_key:
        path = tmp_path / "operator-key"
        path.write_bytes(Fernet.generate_key())
        environment["KROBI_SECRET_KEY_FILE"] = str(path)
    store = vault(tmp_path, environment=environment)
    assert store.get(GENIUS) == "legacy-genius"
    assert {k: store.get(k) for k in values} == values
    assert store.load_credentials("subsonic-app-passwords") == passwords
    assert store.load_credentials("spotify") == {"token": "other-legacy-token"}
    assert (tmp_path / ".env").read_text() == settings
    assert not (store.directory / "genius.json").exists()
    assert not list(store.directory.glob("*.enc"))
    assert (store.directory / ".key").exists() is (not external_key)
    text = store.path.read_text()
    for value in ["legacy-genius", *passwords.values(), *values.values(), "other-legacy-token"]:
        assert value not in text
    assert all(r["value"].startswith("v1:") and r["source"] == "app" and not r["locked"]
               for r in json.loads(text).values())
    again = vault(tmp_path, environment=environment)
    assert again.path.read_text() == text
    assert again.load_credentials("subsonic-app-passwords") == passwords
    assert again.get(GENIUS) == "legacy-genius"
    if not external_key:
        assert (store.directory / ".key").read_bytes() == key


@pytest.mark.parametrize("external_key", [False, True])
def test_legacy_ftp_integer_port_does_not_prevent_startup(tmp_path, monkeypatch, external_key):
    directory = tmp_path / "credentials"
    directory.mkdir()
    key = Fernet.generate_key()
    (directory / ".key").write_bytes(key)
    credentials = {"host": "192.0.2.20", "port": 2121, "username": "listener", "password": "legacy-ftp-password"}
    encrypted = directory / "ftp_android.enc"
    encrypted.write_bytes(Fernet(key).encrypt(json.dumps(credentials).encode()))
    for table in (REQUIRED_DIRS, STATE_PATHS):
        for _, (variable, name) in table.items():
            monkeypatch.setenv(variable, str(tmp_path / name))
    if external_key:
        handoff = tmp_path / "handoff"
        handoff.mkdir()
        (handoff / "krobi-key").write_bytes(key)
        monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(handoff))
    config = ConfigManager.from_env()
    assert config.secrets.load_credentials("ftp_android") == credentials
    assert not encrypted.exists()
    assert "legacy-ftp-password" not in config.secrets.path.read_text()
    assert ConfigManager.from_env().secrets.load_credentials("ftp_android") == credentials


@pytest.mark.parametrize("failure", ["write", "readback", "cleanup"])
def test_migration_failure_keeps_legacy_and_retry_is_safe(tmp_path, monkeypatch, failure):
    legacy(tmp_path)
    from app.infra import secret_store
    original_read = secret_store.read
    original_write = secret_store.write
    if failure == "write":
        monkeypatch.setattr(secret_store, "write", Mock(side_effect=OSError("disk")))
    elif failure == "readback":
        count = 0
        def fail_read(path):
            nonlocal count
            count += 1
            return {} if count > 1 else original_read(path)
        monkeypatch.setattr(secret_store, "read", fail_read)
    else:
        monkeypatch.setattr("app.infra.secrets.write_secret_lines", Mock(side_effect=OSError("disk")))
    with pytest.raises((OSError, ConfigurationError)):
        vault(tmp_path)
    assert (tmp_path / "credentials/genius.json").exists()
    assert (tmp_path / "credentials/subsonic-app-passwords.enc").exists()
    assert "legacy-spotify-secret" in (tmp_path / ".env").read_text()
    monkeypatch.setattr(secret_store, "read", original_read)
    monkeypatch.setattr(secret_store, "write", original_write)
    monkeypatch.setattr("app.infra.secrets.write_secret_lines", files.write_secret_lines)
    recovered = vault(tmp_path)
    assert recovered.get(GENIUS) == "legacy-genius"
    assert not list(recovered.directory.glob("*.enc"))


@pytest.mark.parametrize("source", ["env", "file", "credentials-dir"])
def test_operator_value_wins_over_migrated_key_without_persisting_it(tmp_path, source):
    legacy(tmp_path)
    if source == "env":
        environment = {GENIUS: "operator-value"}
    elif source == "file":
        file = tmp_path / "injected-secret"
        file.write_text("operator-value\n")
        environment = {f"{GENIUS}_FILE": str(file)}
    else:
        directory = tmp_path / "systemd"
        directory.mkdir()
        (directory / GENIUS).write_text("operator-value\n")
        environment = {"CREDENTIALS_DIRECTORY": str(directory)}
    store = vault(tmp_path, environment=environment)
    assert store.get(GENIUS) == "operator-value"
    row = store.describe(GENIUS)
    assert row["locked"] and row["source"] == ("env" if source == "env" else "file")
    with pytest.raises(SecretLockedError):
        store.put(GENIUS, "attempted-overwrite")
    with pytest.raises(SecretLockedError):
        store.delete(GENIUS)
    assert "operator-value" not in store.path.read_text()
    # The old app value is still recoverable if the operator later unpins it.
    assert vault(tmp_path).get(GENIUS) == "legacy-genius"


@pytest.mark.parametrize("name", SECRET_ATTRS)
@pytest.mark.parametrize("case", ["both", "empty", "credential-empty", "missing"])
def test_bad_external_configuration_refuses_with_name(tmp_path, name, case):
    path = tmp_path / name
    path.write_text(" \n")
    environment = {f"{name}_FILE": str(path)}
    if case == "both":
        environment[name] = "a-value"
    elif case == "credential-empty":
        environment = {"CREDENTIALS_DIRECTORY": str(tmp_path)}
    elif case == "missing":
        path.unlink()
    with pytest.raises(ConfigurationError, match=name):
        vault(tmp_path, environment=environment)
    assert not (tmp_path / "credentials/.key").exists()


@pytest.mark.parametrize("loss", ["changed", "missing", "invalid", "ciphertext"])
def test_changed_or_missing_key_is_typed_and_never_replaces_metadata(tmp_path, loss):
    store = vault(tmp_path)
    store.put(GENIUS, "do-not-lose-this")
    fingerprint = json.loads((tmp_path / "instance.json").read_text())["secretKey"]
    original = store.path.read_bytes()
    path = store.directory / ".key"
    if loss == "changed":
        path.write_bytes(Fernet.generate_key())
    elif loss == "missing":
        path.unlink()
    elif loss == "invalid":
        path.write_bytes(b"invalid-fernet")
    else:
        records = json.loads(original)
        value = records[GENIUS]["value"]
        records[GENIUS]["value"] = value[:-10] + ("A" if value[-10] != "A" else "B") + value[-9:]
        store.path.write_text(json.dumps(records))
    broken = vault(tmp_path)
    assert broken.unreadable
    assert all(r["state"] == "ilegible" and r["reason"] == "llave-distinta" for r in broken.describe_all()["secrets"])
    with pytest.raises(SecretUnreadableError):
        broken.get(GENIUS)
    with pytest.raises(SecretUnreadableError):
        broken.put(GENIUS, "never-write-garbage")
    assert json.loads((tmp_path / "instance.json").read_text())["secretKey"] == fingerprint
    if loss != "ciphertext":
        assert store.path.read_bytes() == original
    if loss == "missing":
        assert not path.exists()


def test_missing_legacy_key_does_not_generate_a_replacement(tmp_path):
    legacy(tmp_path)
    (tmp_path / "credentials/.key").unlink()
    store = vault(tmp_path)
    assert store.unreadable
    assert (store.directory / "genius.json").exists()
    assert not (store.directory / ".key").exists()


@pytest.mark.parametrize("loss", ["missing", "invalid"])
def test_unavailable_legacy_key_with_external_key_still_boots(tmp_path, loss):
    legacy(tmp_path)
    path = tmp_path / "credentials/.key"
    if loss == "missing":
        path.unlink()
    else:
        path.write_bytes(b"invalid-key")
    external = tmp_path / "operator-key"
    external.write_bytes(Fernet.generate_key())
    store = vault(tmp_path, environment={"KROBI_SECRET_KEY_FILE": str(external)})
    assert store.unreadable
    row = next(r for r in store.describe_all()["secrets"] if r["name"] == "subsonic-app-passwords")
    assert row["state"] == "ilegible" and row["reason"] == "llave-distinta"
    assert (store.directory / "subsonic-app-passwords.enc").exists()
    assert (store.directory / "genius.json").exists()


def test_multifernet_rotation_and_instance_metadata_preservation(tmp_path):
    (tmp_path / "instance.json").write_text(json.dumps({"instanceId": "stable", "name": "Nest", "externalUrl": "https://nest.example"}))
    store = vault(tmp_path)
    store.put(GENIUS, "rotate-me")
    old_key = (store.directory / ".key").read_bytes()
    old_ciphertext = store.records[GENIUS]["value"]
    new_key = Fernet.generate_key()
    ring = tmp_path / "operator-ring"
    ring.write_bytes(new_key + b"\n" + old_key)
    environment = {"KROBI_SECRET_KEY_FILE": str(ring)}
    rotated = vault(tmp_path, environment=environment)
    assert rotated.get(GENIUS) == "rotate-me"
    assert rotated.records[GENIUS]["value"] != old_ciphertext
    assert Fernet(new_key).decrypt(rotated.records[GENIUS]["value"].split(":", 2)[2].encode()) == b"rotate-me"
    ring.write_bytes(new_key)
    assert vault(tmp_path, environment=environment).get(GENIUS) == "rotate-me"
    metadata = json.loads((tmp_path / "instance.json").read_text())
    assert metadata["instanceId"] == "stable" and metadata["name"] == "Nest"
    assert metadata["externalUrl"] == "https://nest.example"
    assert metadata["secretKey"] == {"fingerprint": sha256(new_key).hexdigest()[:8], "source": "key-file"}


def test_key_resolution_precedence(tmp_path):
    systemd = tmp_path / "systemd"
    systemd.mkdir()
    first, second = Fernet.generate_key(), Fernet.generate_key()
    (systemd / "krobi-key").write_bytes(first)
    other = tmp_path / "other-key"
    other.write_bytes(second)
    store = vault(tmp_path, environment={"CREDENTIALS_DIRECTORY": str(systemd), "KROBI_SECRET_KEY_FILE": str(other)})
    assert store.key_info == {"fingerprint": sha256(first).hexdigest()[:8], "source": "credentials-dir"}
    assert not (store.directory / ".key").exists()


def test_same_value_mask_and_delete_are_repeatable(tmp_path):
    store = vault(tmp_path)
    assert store.put(GENIUS, "same-value")
    before = store.path.read_bytes()
    assert not store.put(GENIUS, "same-value")
    assert not store.put(GENIUS, "••••••••")
    assert before == store.path.read_bytes()
    assert store.delete(GENIUS)
    assert not store.delete(GENIUS)
    assert vault(tmp_path).get(GENIUS) is None


def test_dotenv_secrets_stay_app_owned_across_environment_loading(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text('SPOTIFY_CLIENT_SECRET=app-owned\nKROBI_WRITE_ANALYSIS_TAGS=true\n')
    for name in SECRET_ATTRS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("KROBI_CREDENTIALS_DIR", str(tmp_path / "credentials"))
    monkeypatch.delenv("KROBI_WRITE_ANALYSIS_TAGS", raising=False)
    env_sources.load_environment(tmp_path)
    assert "SPOTIFY_CLIENT_SECRET" not in os.environ
    assert os.environ["KROBI_WRITE_ANALYSIS_TAGS"] == "true"
    store = vault(tmp_path, environment=dict(os.environ))
    assert store.get("SPOTIFY_CLIENT_SECRET") == "app-owned"
    assert not store.describe("SPOTIFY_CLIENT_SECRET")["locked"]


def test_boot_refuses_bad_secret_file_configuration(tmp_path, monkeypatch):
    for table in (REQUIRED_DIRS, STATE_PATHS):
        for _, (variable, name) in table.items():
            monkeypatch.setenv(variable, str(tmp_path / name))
    monkeypatch.setenv(GENIUS, "set")
    monkeypatch.setenv(f"{GENIUS}_FILE", str(tmp_path / "absent"))
    with pytest.raises(ConfigurationError, match=GENIUS):
        ConfigManager.from_env()


def test_migration_preserves_nonsecret_bytes_and_newlines(tmp_path):
    preserved = b'# comment\r\nKROBI_WRITE_ANALYSIS_TAGS=true\r\n\r\n'
    (tmp_path / ".env").write_bytes(preserved + b'SPOTIFY_CLIENT_SECRET=private\r\n')
    store = vault(tmp_path)
    assert store.get("SPOTIFY_CLIENT_SECRET") == "private"
    assert (tmp_path / ".env").read_bytes() == preserved


def test_explicit_key_file_can_point_to_local_key_without_deleting_it(tmp_path):
    legacy(tmp_path)
    path = tmp_path / "credentials/.key"
    store = vault(tmp_path, environment={"KROBI_SECRET_KEY_FILE": str(path)})
    assert store.get(GENIUS) == "legacy-genius"
    assert path.exists()
    assert vault(tmp_path, environment={"KROBI_SECRET_KEY_FILE": str(path)}).get(GENIUS) == "legacy-genius"
