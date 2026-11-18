"""Compatibility port for encrypted dictionaries, backed by the one store."""
from app.infra.secrets import SecretUnreadableError


class CredentialsRepository:
    def __init__(self, config, logger):
        self.config = config
        self.logger = logger

    def save_credentials(self, key: str, credentials: dict[str, str]) -> None:
        self.config.secrets.save_credentials(key, credentials)

    def load_credentials(self, key: str) -> dict[str, str] | None:
        return self.config.secrets.load_credentials(key)

    def delete_credentials(self, key: str) -> None:
        self.config.secrets.delete(key)

    def credentials_exist(self, key: str) -> bool:
        try:
            return bool(self.config.secrets.get(key))
        except SecretUnreadableError:
            return False
