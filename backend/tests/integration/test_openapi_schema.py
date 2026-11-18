"""Compare the live schema with the committed client-generation input.

Review intentional schema changes before accepting with UPDATE_API_SCHEMA=1
and regenerating types via npm run api:generate. See docs/API_COMPATIBILITY.md.
"""
import json
import os
from pathlib import Path

from app.main import app

COMMITTED_SCHEMA = Path(__file__).resolve().parents[3] / "renderer" / "api-schema.json"


def _differences(live: dict, committed: dict) -> list[str]:
    live_paths, committed_paths = set(live.get("paths", {})), set(committed.get("paths", {}))
    lines = [f"added route: {p}" for p in sorted(live_paths - committed_paths)]
    lines += [f"removed route: {p}" for p in sorted(committed_paths - live_paths)]
    lines += [
        f"changed route: {p}"
        for p in sorted(live_paths & committed_paths)
        if live["paths"][p] != committed["paths"][p]
    ]
    live_models = live.get("components", {}).get("schemas", {})
    committed_models = committed.get("components", {}).get("schemas", {})
    lines += [
        f"changed model: {m}"
        for m in sorted(set(live_models) | set(committed_models))
        if live_models.get(m) != committed_models.get(m)
    ]
    if live.get("info") != committed.get("info"):
        lines.append("changed info block")
    return lines


def test_the_running_app_serves_the_committed_schema():
    live = app.openapi()

    if os.environ.get("UPDATE_API_SCHEMA") == "1":
        COMMITTED_SCHEMA.write_text(json.dumps(live, indent=2, ensure_ascii=False) + "\n")

    committed = json.loads(COMMITTED_SCHEMA.read_text())
    differences = _differences(live, committed)
    assert not differences, (
        "The API no longer matches renderer/api-schema.json:\n  "
        + "\n  ".join(differences)
        + "\nIf this change is intended, rerun with UPDATE_API_SCHEMA=1 and then `npm run api:generate`."
    )


def test_helper_wire_keeps_worker_and_documents_optional_capabilities():
    models = app.openapi()["components"]["schemas"]
    engine = models["LyricsEngineResponse"]["properties"]
    assert {"worker", "helpers", "waitReason"} <= engine.keys()
    identity = models["AgentIdentity"]
    optional = {"os", "accel", "gpu", "chip", "memoryBytes", "jobs", "keepAwake"}
    assert optional <= identity["properties"].keys()
    assert not optional.intersection(identity.get("required", []))
    assert "revoked" in models["MacWorker"]["properties"]["state"]["enum"]


def test_playlist_cover_versions_are_an_additive_nullable_array():
    schema = app.openapi()["components"]["schemas"]["PlaylistSummary"]
    versions = schema["properties"]["coverVersions"]
    assert versions["type"] == "array"
    assert versions["items"]["anyOf"] == [{"type": "string"}, {"type": "null"}]
    assert versions["default"] == []
    assert "coverVersions" not in schema.get("required", [])


def test_lyrics_has_only_current_and_optional_renderer_undo_metadata():
    schema = app.openapi()
    models = schema["components"]["schemas"]
    assert "previous" not in models["LyricsRecordResponse"]["properties"]
    assert "PreviousLyricsResponse" not in models
    assert "/api/lyrics/{album}/{file}/previous" not in schema["paths"]
    assert "restore" not in models["SaveLyricsRequest"].get("required", [])
