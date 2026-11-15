"""Capability matching and pull scheduling shared by both helper queues.

A hardware tier is used until both helpers have three measurements. Within a
measured cohort, elapsed seconds per song minute decides instead.
"""
from __future__ import annotations

from typing import Any, Literal

SLOW_DELAY_S = 60.0
NEST_FALLBACK_AFTER_S = 600.0
MIN_MEMORY_BYTES = 8 << 30
WaitReason = Literal["no-helper", "no-capable-helper", "helpers-offline", "helpers-busy"]


def default_needs(kind: str) -> list[str]:
    return [f"jobs:{kind}", f"memoryBytes>={MIN_MEMORY_BYTES}"]


def capable(helper: dict[str, Any], kind: str, needs: list[str]) -> bool:
    if helper.get('versionState') == 'too-old':
        return False
    if kind == 'analysis':
        labels = helper.get('labels', [])
        for need in needs:
            if need.startswith('analysis>='):
                required = int(need.partition('>=')[2])
                versions = [int(label.partition('>=')[2]) for label in labels
                            if label.startswith('analysis>=') and label.partition('>=')[2].isdigit()]
                if not versions or max(versions) < required:
                    return False
            elif need != 'jobs:analysis':
                return False
        return 'analysis' in helper.get('jobs', [])
    memory = helper.get("memoryBytes")
    legacy_mac = memory is None and helper.get("os", "macos") == "macos" and helper.get("accel", "mlx") == "mlx"
    if kind not in helper.get("jobs", []) or not (legacy_mac or memory is not None and memory >= MIN_MEMORY_BYTES):
        return False
    labels = {f"jobs:{job}" for job in helper.get("jobs", [])}
    labels.update((f"accel:{helper.get('accel')}", f"os:{helper.get('os')}", f"memoryBytes>={MIN_MEMORY_BYTES}"))
    return set(needs) <= labels


def online(helper: dict[str, Any]) -> bool:
    return helper["state"] not in ("asleep", "closed", "offline", "revoked")


def faster(a: dict[str, Any], b: dict[str, Any], kind: str) -> bool:
    if bool(a.get("nest")) != bool(b.get("nest")):
        return bool(b.get("nest"))
    sa, sb = a.get("speed", {}).get(kind, {}), b.get("speed", {}).get(kind, {})
    if sa.get("samples", 0) >= 3 and sb.get("samples", 0) >= 3:
        return sa["medianSecondsPerMinute"] < sb["medianSecondsPerMinute"]
    return (a.get("accel") == "cpu") < (b.get("accel") == "cpu")


def claim_rank(helpers: list[dict[str, Any]], identity: str, kind: str, needs: list[str]) -> tuple[int, int]:
    eligible = [h for h in helpers if online(h) and capable(h, kind, needs)]
    candidate = next(h for h in eligible if h["id"] == identity)
    return 1 + sum(faster(h, candidate, kind) for h in eligible), len(eligible)


def can_claim(helpers: list[dict[str, Any]], identity: str, kind: str, needs: list[str], offered_at: float, *, now: float) -> bool:
    eligible = [h for h in helpers if online(h) and capable(h, kind, needs)]
    candidate = next((h for h in eligible if h["id"] == identity), None)
    if candidate is None or candidate.get("job") is not None or candidate["state"] == "working":
        return False
    if candidate.get("nest"):
        real = [h for h in helpers if not h.get("nest")]
        others = [h for h in [*real, *[p for h in real for p in h.get("recentCapabilities", [])]]
                  if capable(h, kind, needs)]
        if any(online(h) for h in others):
            return False  # Busy real helpers also reserve the nest's CPU for serving.
        absent_since = max([candidate["fallbackSince"], *[h["unavailableSince"] for h in others]])
        return now - absent_since >= NEST_FALLBACK_AFTER_S
    return now - offered_at >= SLOW_DELAY_S or not any(
        faster(h, candidate, kind) and h.get("job") is None and h["state"] != "working" for h in eligible
    )


def wait_reason(helpers: list[dict[str, Any]], kind: str, needs: list[str]) -> WaitReason | None:
    helpers = [h for h in helpers if h["state"] != "revoked"]
    if not helpers:
        return "no-helper"
    eligible = [h for h in helpers if capable(h, kind, needs)]
    if not eligible:
        return "no-capable-helper"
    live = [h for h in eligible if online(h)]
    if not live:
        return "helpers-offline"
    return "helpers-busy" if all(h.get("job") is not None or h["state"] == "working" for h in live) else None
