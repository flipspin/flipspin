"""Features contribute capabilities and result application; infra imports none."""
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class JobKind:
    name: str
    needs: tuple[str, ...]
    apply_result: Callable[..., Any]
    ledger_kind: str
    queued_phase: str | None = None
    failed_phase: str | None = None
    show_retry_error: bool = True
    order: int = 0
    can_claim: Callable[[dict, str], bool] | None = None
    provenance: Callable[[str], dict] | None = None


class Kinds:
    def __init__(self):
        self._kinds: dict[str, JobKind] = {}

    def register(self, kind: JobKind):
        self._kinds[kind.name] = kind

    def __getitem__(self, name: str) -> JobKind:
        return self._kinds[name]

    def __iter__(self):
        return iter(self._kinds.values())
