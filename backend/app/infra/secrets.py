"""The nest's sole credentials boundary.

External values are resolved once at boot and kept in memory; app writes never
persist or replace them. Key files accept a newline-separated Fernet ring, newest
first. Keeping the previous key in the ring authorizes atomic re-encryption.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.exceptions import ConfigurationError
from app.infra import env_sources, instance, secret_store
from app.infra.files import PRIVATE, write_bytes_atomic, write_secret_lines

# Public names deliberately match the installer's environment variables.
SECRET_ATTRS = {
    "KROBI_GENIUS_API_KEY": "genius_api_key",
    "SPOTIFY_CLIENT_ID": "spotify_client_id",
    "SPOTIFY_CLIENT_SECRET": "spotify_client_secret",
    "SPOTIFY_REFRESH_TOKEN": "spotify_refresh_token",
}
_lock = threading.RLock()


class SecretLockedError(ConfigurationError):
    def __init__(self, name: str):
        super().__init__("fijada por el entorno", {"code": "env-locked", "key": name})


class SecretUnreadableError(ConfigurationError):
    def __init__(self):
        super().__init__("llave-distinta", {"code": "llave-distinta"})


def is_mask(value: str) -> bool:
    return bool(value) and set(value) <= {"•", "*", "●"}


class SecretStore:
    def __init__(self, directory: Path, instance_file: Path, *, environment: dict | None = None, env_path: Path | None = None):
        self.directory = Path(directory)
        self.path = self.directory / "secrets.json"
        self.instance_file = Path(instance_file)
        self.env_path = env_path if env_path is not None else directory.parent / ".env"
        self.environment = dict(os.environ if environment is None else environment)
        self.external: dict[str, tuple[str, str]] = {}
        self.unreadable = False
        self.key_info: dict = {"fingerprint": None, "source": "generated"}
        self._cipher: MultiFernet | None = None
        self._kids: set[str] = set()
        self._key_ring: bytes | None = None
        with _lock:
            self._legacy_names = {path.stem for path in self.directory.glob("*.enc")}
            self.records = self._read()
            self._resolve_external()
            self._resolve_key()
            if not self.unreadable:
                self._migrate()

    def _read(self) -> dict:
        try:
            records = secret_store.read(self.path)
            for name, record in records.items():
                if not isinstance(name, str) or not isinstance(record, dict) or not isinstance(record.get("value"), str):
                    raise ValueError
            return records
        except (OSError, ValueError, TypeError):
            raise ConfigurationError("Unable to read secrets store") from None

    def _file_value(self, path: Path, name: str) -> str:
        try:
            value = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError):
            raise ConfigurationError(f"Unable to read {name}") from None
        if not value:
            raise ConfigurationError(f"Empty secret file: {name}")
        return value

    def _resolve_external(self) -> None:
        credentials = self.environment.get("CREDENTIALS_DIRECTORY")
        for name in SECRET_ATTRS:
            file_name = f"{name}_FILE"
            if name in self.environment and file_name in self.environment:
                raise ConfigurationError(f"Both {name} and {file_name} are set")
            credential = Path(credentials) / name if credentials else None
            if file_name in self.environment:
                value = self._file_value(Path(self.environment[file_name]), name)
                self.external[name] = (value, "file")
            elif name in self.environment:
                self.external[name] = (self.environment[name], "env")
            elif credential and credential.exists():
                self.external[name] = (self._file_value(credential, name), "file")

    def _resolve_key(self) -> None:
        credentials = self.environment.get("CREDENTIALS_DIRECTORY")
        credential = Path(credentials) / "krobi-key" if credentials else None
        local = self.directory / ".key"
        if credential and credential.exists():
            path, source = credential, "credentials-dir"
        elif "KROBI_SECRET_KEY_FILE" in self.environment:
            path, source = Path(self.environment["KROBI_SECRET_KEY_FILE"]), "key-file"
        else:
            path, source = local, "generated"
        self.key_info["source"] = source
        self._key_path = path
        previous = instance.read_secret_key(self.instance_file)
        if not path.exists():
            # Never replace a lost key with a new one and silently lose data.
            if self.records or previous or any(self.directory.glob("*.enc")):
                self.unreadable = True
                self.key_info["fingerprint"] = previous.get("fingerprint") if previous else None
                return
            if source != "generated":
                self.unreadable = True
                return
            write_bytes_atomic(local, Fernet.generate_key(), mode=PRIVATE)
        try:
            keys = path.read_bytes().split()
            ciphers = [Fernet(key) for key in keys]
            if not ciphers:
                raise ValueError
        except (OSError, ValueError):
            self.unreadable = True
            return
        self._kids = {sha256(key).hexdigest()[:8] for key in keys}
        self.key_info["fingerprint"] = sha256(keys[0]).hexdigest()[:8]
        self._cipher = MultiFernet(ciphers)
        if previous and previous.get("fingerprint") not in self._kids:
            self.unreadable = True
            return
        try:
            for record in self.records.values():
                self._decrypt(record["value"])
        except SecretUnreadableError:
            self.unreadable = True
            return
        # A ring containing the previous key explicitly authorizes rotation.
        rotated = {name: {**r, "value": self._encrypt(self._decrypt(r["value"]))}
                   for name, r in self.records.items()
                   if not r["value"].startswith(f"v1:{self.key_info['fingerprint']}:")}
        if rotated:
            self._commit({**self.records, **rotated})
        if source == "generated" and path.stat().st_mode & 0o777 != PRIVATE:
            # Secure legacy key files by atomic replacement, never chmod after
            # writing. The key bytes (and therefore fingerprint) stay identical.
            write_bytes_atomic(path, path.read_bytes(), mode=PRIVATE)
        instance.set_secret_key(self.instance_file, self.key_info)
        self._key_ring = b"\n".join(keys) + b"\n"

    def export_key(self) -> bytes:
        """Export the validated boot key ring, never a file replaced after boot."""
        with _lock:
            if self.unreadable or self._key_ring is None:
                raise SecretUnreadableError()
            return self._key_ring

    def _decrypt(self, value: str) -> str:
        try:
            version, kid, token = value.split(":", 2)
            if version != "v1" or kid not in self._kids or self._cipher is None:
                raise ValueError
            return self._cipher.decrypt(token.encode()).decode()
        except (ValueError, InvalidToken, UnicodeError):
            raise SecretUnreadableError() from None

    def _encrypt(self, value: str) -> str:
        if self.unreadable or self._cipher is None:
            raise SecretUnreadableError()
        return f"v1:{self.key_info['fingerprint']}:{self._cipher.encrypt(value.encode()).decode()}"

    def _record(self, value: str) -> dict:
        return dict(value=self._encrypt(value), source="app", locked=False,
                    state="guardada" if value else "falta", verified_at=None, rejected_reason=None)

    def _commit(self, records: dict) -> None:
        secret_store.write(self.path, records)
        # Read back the durable version before changing memory or removing sources.
        persisted = secret_store.read(self.path)
        if persisted != records:
            raise ConfigurationError("Secrets store verification failed")
        for record in persisted.values():
            self._decrypt(record["value"])
        self.records = persisted

    def _migrate(self) -> None:
        legacy: dict[str, str] = {}
        remove: list[Path] = []
        genius = self.directory / "genius.json"
        env_path = self.env_path
        try:
            if genius.exists():
                key = json.loads(genius.read_text(encoding="utf-8"))["apiKey"]
                if not isinstance(key, str):
                    raise ValueError
                legacy["KROBI_GENIUS_API_KEY"] = key
                remove.append(genius)
            values = env_sources.read_values(env_path)
            for name in SECRET_ATTRS:
                if name in values:
                    legacy.setdefault(name, values[name])
            encrypted = list(self.directory.glob("*.enc"))
            if encrypted:
                try:
                    old_keys = (self.directory / ".key").read_bytes().split()
                    old_cipher = MultiFernet([Fernet(key) for key in old_keys])
                except (OSError, ValueError):
                    self.unreadable = True
                    return
                for path in encrypted:
                    plaintext = old_cipher.decrypt(path.read_bytes()).decode()
                    data = json.loads(plaintext)
                    # Legacy records contain typed settings too, such as integer FTP ports.
                    if not isinstance(data, dict):
                        raise ValueError
                    legacy[path.stem] = json.dumps(data)
                    remove.append(path)
        except InvalidToken:
            self.unreadable = True
            return
        except (OSError, ValueError, KeyError, TypeError, UnicodeError):
            raise ConfigurationError("Unable to migrate legacy credentials") from None
        if not legacy and not remove:
            if self.records:
                self._remove_legacy_key()
            return
        # Keep an already migrated record on retries after a cleanup failure.
        merged = dict(self.records)
        for name, value in legacy.items():
            if name not in merged:
                merged[name] = self._record(value)
        self._commit(merged)
        # Only the secret assignments are removed; all other bytes stay intact.
        if any(name in values for name in SECRET_ATTRS):
            with env_path.open(encoding="utf-8", newline="") as handle:
                lines = handle.readlines()
            write_secret_lines(env_path, [line for line in lines
                                         if line.strip().removeprefix("export ").partition("=")[0].strip()
                                         not in SECRET_ATTRS])
        for path in remove:
            path.unlink(missing_ok=True)
        self._remove_legacy_key()

    def _remove_legacy_key(self) -> None:
        local = self.directory / ".key"
        if self.key_info["source"] != "generated" and self._key_path.resolve() != local.resolve():
            local.unlink(missing_ok=True)

    def get(self, name: str) -> str | None:
        with _lock:
            if name in self.external:
                return self.external[name][0] or None
            if self.unreadable:
                raise SecretUnreadableError()
            record = self.records.get(name)
            return (self._decrypt(record["value"]) or None) if record else None

    def check_writable(self, name: str) -> None:
        if name == "KROBI_API_TOKEN" or name in self.external or name in env_sources.ENV_KEYS:
            raise SecretLockedError(name)
        if self.unreadable:
            raise SecretUnreadableError()

    def put(self, name: str, value: str) -> bool:
        return bool(self.update({name: value}))

    def delete(self, name: str) -> bool:
        return bool(self.update({name: None}))

    def update(self, changes: dict[str, str | None]) -> list[str]:
        """One atomic replacement, including paired Spotify settings."""
        with _lock:
            for name in changes:
                self.check_writable(name)
            records = dict(self.records)
            changed = []
            for name, value in changes.items():
                if value is None:
                    if name not in records:
                        continue
                    del records[name]
                else:
                    if is_mask(value) or self.get(name) == (value or None):
                        continue
                    record = self._record(value)
                    # A transient verifier failure must not flip a prior state.
                    # A previous timestamp does not attest this replacement.
                    if name in records:
                        record.update(state=records[name]["state"],
                                      rejected_reason=records[name].get("rejected_reason"))
                    records[name] = record
                changed.append(name)
            if changed:
                self._commit(records)
            return changed

    def mark_verified(self, name: str, *, reason: str | None = None) -> None:
        with _lock:
            record = self.records[name]
            self._commit({**self.records, name: {**record, "state": "rechazada" if reason else "guardada",
                                                "verified_at": datetime.now(UTC).isoformat(),
                                                "rejected_reason": reason}})

    def describe(self, name: str) -> dict:
        external = self.external.get(name)
        record = self.records.get(name, {})
        state = ("guardada" if external[0] else "falta") if external else record.get("state", "falta")
        return dict(name=name,
                    state="ilegible" if self.unreadable else state,
                    source=external[1] if external else record.get("source", "app"),
                    locked=bool(external) or name in env_sources.ENV_KEYS,
                    verifiedAt=None if external else record.get("verified_at"),
                    reason="llave-distinta" if self.unreadable else
                    None if external else record.get("rejected_reason"))

    def describe_all(self) -> dict:
        with _lock:
            names = set(SECRET_ATTRS) | self.records.keys() | self._legacy_names
            encrypted = [name for name in self.records if name in SECRET_ATTRS]
            try:
                app_passwords = len(json.loads(self.get("subsonic-app-passwords") or "{}"))
            except (SecretUnreadableError, ValueError, TypeError):
                app_passwords = None
            return {"secrets": [self.describe(name) for name in sorted(names)],
                    "key": dict(self.key_info),
                    "counts": {"sources": len(encrypted), "appPasswords": app_passwords}}

    def load_credentials(self, name: str) -> dict[str, str] | None:
        try:
            value = self.get(name)
        except SecretUnreadableError:
            return None
        return json.loads(value) if value else None

    def save_credentials(self, name: str, credentials: dict[str, str]) -> None:
        self.put(name, json.dumps(credentials))


def apply_to_config(config) -> None:
    for name, attr in SECRET_ATTRS.items():
        try:
            value = config.secrets.get(name)
        except SecretUnreadableError:
            value = None
        setattr(config, attr, value)
