"""Timestamps the server writes into its own files."""
from datetime import UTC, datetime


def utc_now_iso() -> str:
    """Now, as fixed-width ISO-8601 UTC to the second: ``2026-08-20T11:02:31Z``.

    Fixed width is load-bearing: the account and library stores compare these
    strings to compare instants.
    """
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
