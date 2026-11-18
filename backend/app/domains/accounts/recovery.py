"""Operator password recovery through access to the server data directory.

Preserve account-file ownership and existing device credentials.
Read passwords from a prompt or stdin, never command-line arguments.
See docs/security.md#recovery.
"""
import argparse
import getpass
import logging
import os
import sys

from app.config import ConfigManager
from app.infra.paths import data_root
from app.infra.env_sources import load_environment
from app.domains.accounts.identity import IdentityError, TokenStore
from app.domains.accounts.passwords import MAX_PASSWORD_LENGTH


def reset_password(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="python -m app reset-password")
    parser.add_argument("username")
    parser.add_argument("--password-stdin", action="store_true", help="read one password line from stdin")
    args = parser.parse_args(argv)
    load_environment(data_root())
    path = ConfigManager.from_env().users_file
    # docker exec defaults to root in the server image. Recover as the table's
    # owner so the atomic 0600 replacement stays readable by the live server.
    if hasattr(os, "geteuid") and os.geteuid() == 0 and path.exists():
        owner = path.stat()
        if owner.st_uid != 0:
            os.setgroups([])
            os.setgid(owner.st_gid)
            os.setuid(owner.st_uid)
    store = TokenStore(path, logging.getLogger(__name__))
    try:
        account = store.user_by_username(args.username)
        if args.password_stdin:
            password = sys.stdin.readline(MAX_PASSWORD_LENGTH + 2).rstrip("\r\n")
        else:
            password = getpass.getpass("Nueva contraseña: ")
            if password != getpass.getpass("Repite la contraseña: "):
                parser.exit(1, "Las contraseñas no coinciden.\n")
        store.reset_password(account.user_id, password)
    except (IdentityError, EOFError, KeyboardInterrupt) as error:
        # Identity errors contain policy/account metadata only, never secrets.
        parser.exit(1, f"No se pudo restablecer la contraseña: {error}\n")
    print(f"Contraseña restablecida: {account.username} ({account.label}).")
