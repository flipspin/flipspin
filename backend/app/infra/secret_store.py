"""Private persistence port. Only infra.secrets may use this module."""
import json
from pathlib import Path

from app.infra.files import PRIVATE, write_json_atomic


def read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError
        return data
    except FileNotFoundError:
        return {}


def write(path: Path, records: dict) -> None:
    write_json_atomic(path, records, mode=PRIVATE)
