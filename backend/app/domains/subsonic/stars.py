"""Starred albums and artists, per account (``subsonic-stars.json`` beside ``users.json``).

A starred *song* is not kept here: it is the account's library row with
``liked`` set (``/api/me/library``), so Krobi's own apps and a Subsonic client
see the same favourites. Albums and artists have no row of their own in Krobi,
so their stars live in this small file.
"""
from __future__ import annotations

import json
import threading

from app.utils.clock import utc_now_iso
from pathlib import Path

from app.infra.files import PRIVATE, write_json_atomic



class StarStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, str]] | None = None

    def _load(self) -> dict[str, dict[str, str]]:
        if self._data is None:
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                self._data = {u: dict(v) for u, v in raw.items() if isinstance(v, dict)}
            except (OSError, ValueError, AttributeError):
                self._data = {}
        return self._data

    def starred(self, user_id: str) -> dict[str, str]:
        """``id → starredAt`` for this account (album and artist ids)."""
        with self._lock:
            return dict(self._load().get(user_id, {}))

    def set(self, user_id: str, item_ids: list[str], starred: bool) -> None:
        if not item_ids:
            return
        with self._lock:
            data = self._load()
            mine = data.setdefault(user_id, {})
            for item in item_ids:
                if starred:
                    mine.setdefault(item, utc_now_iso())
                else:
                    mine.pop(item, None)
            write_json_atomic(self.path, data, mode=PRIVATE)


def stars_file_for(users_file: Path) -> Path:
    """Where the stars live: beside ``users.json``. The store itself is held by
    the container (``DependencyContainer.get_star_store``)."""
    return Path(users_file).with_name("subsonic-stars.json")
