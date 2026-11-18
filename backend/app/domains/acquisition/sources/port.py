"""Version-one source port. Rows are neutral; recording decisions stay in core."""
from collections.abc import Callable
from pathlib import Path
from typing import Protocol


class SourcePort(Protocol):
    id: str
    url_hosts: frozenset[str]

    def ready(self) -> bool: ...

    async def test(self, *, deadline: int = 30_000) -> dict: ...

    async def status(self, *, deadline: int = 30_000) -> dict: ...

    async def action(self, id: str, value=None, *, deadline: int = 120_000) -> dict: ...

    async def search(self, wanted: dict, *, limit: int = 10, deadline: int = 30_000,
                     options: dict | None = None) -> list[dict]: ...

    async def fetch(self, candidate_id: str, directory: Path, *, deadline: int,
                    options: dict | None = None, progress: Callable[[float], None] | None = None) -> dict: ...

    def close(self) -> None: ...
