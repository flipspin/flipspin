"""Shared, persistent helper presence for the lyrics and stems queues.

The historical names stay import-compatible. Queue locks use this record's
RLock so session replacement, goodbye and revocation release both queues as
one operation, without lock-order inversions.
"""
from __future__ import annotations

import json
import logging
import math
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from statistics import median
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.infra.changes import Changes
from app.infra.files import SHARED, write_json_atomic
from app.domains.helpers import helper_ranking as ranking

AGENT_ONLINE_S = 90.0
# The unified claim/lease/result envelope first shipped in 0.10.0. Later
# retries and redirect authentication fixes do not change that protocol.
MIN_WORKER_VERSION = "0.10.0"
# Kept in sync with helper/release.json by the release guard.
SHIPPED_WORKER_VERSION = "0.15.8"
REPLACED = {"stop": True, "reason": "replaced"}
ALL_JOBS = ["align", "transcribe", "stems"]
REVOKED_HISTORY_S = 30 * 24 * 60 * 60
logger = logging.getLogger(__name__)


class EngineInventory(BaseModel):
    installed: bool = False
    ready: bool = False
    sizeBytes: int | None = Field(None, ge=0)
    sharedBytes: int | None = Field(None, ge=0)


class AgentIdentity(BaseModel):
    id: str | None = None
    name: str
    sessionId: str | None = None
    platform: str = ""
    os: Literal["macos", "windows", "linux"] = "macos"
    accel: Literal["mlx", "cuda", "cpu"] = "mlx"
    gpu: str | None = None
    chip: str | None = None
    memoryBytes: int | None = Field(None, ge=0)
    jobs: list[Literal["align", "transcribe", "stems", "analysis"]] = Field(default_factory=lambda: ALL_JOBS.copy())
    labels: list[str] = Field(default_factory=list)
    keepAwake: Literal["held", "failed", "none"] = "none"
    macos: str | None = None
    version: str = ""
    utcOffsetMinutes: int | None = Field(None, ge=-840, le=840)
    engines: dict[str, EngineInventory] | None = None
    onBattery: bool | None = None
    powerReadable: bool | None = None
    pausedReason: Literal['thermal', 'battery', 'hours', 'paused', 'off'] | None = None
    state: str = "idle"
    lastError: Literal["network-denied", "token-rejected", "nest-unreachable"] | None = None


class WorkerJob(BaseModel):
    title: str
    phase: str | None = None


class HelperBlockedReason(BaseModel):
    code: Literal['no-engine', 'no-cgroup', 'memory', 'thermal']
    kind: Literal['align', 'transcribe', 'stems', 'analysis'] | None = None
    requiredBytes: int | None = None
    availableBytes: int | None = None


class MacWorker(BaseModel):
    id: str
    nest: bool = False
    name: str
    sessionId: str | None = None
    os: Literal["macos", "windows", "linux"] = "macos"
    accel: Literal["mlx", "cuda", "cpu"] = "mlx"
    gpu: str | None = None
    chip: str | None = None
    memoryBytes: int | None = None
    jobs: list[Literal["align", "transcribe", "stems", "analysis"]] = Field(default_factory=lambda: ALL_JOBS.copy())
    utcOffsetMinutes: int | None = Field(None, ge=-840, le=840)
    engines: dict[str, EngineInventory] | None = None
    onBattery: bool | None = None
    powerReadable: bool | None = None
    speed: dict[str, dict[str, int | float]] = Field(default_factory=dict)
    labels: list[str] = Field(default_factory=list)
    keepAwake: Literal["held", "failed", "none"] = "none"
    goodbye: Literal["asleep", "closed"] | None = None
    macos: str | None = None
    version: str
    minimumVersion: str = MIN_WORKER_VERSION
    versionState: Literal["current", "update", "too-old"] = "current"
    state: Literal["working", "idle", "asleep", "closed", "offline", "outdated", "revoked"]
    lastError: Literal["network-denied", "token-rejected", "nest-unreachable"] | None = None
    lastSeenAt: float
    job: WorkerJob | None = None
    disabledReason: Literal['no-engine', 'no-cgroup', 'memory'] | None = None
    disabledMessage: str | None = None
    blockedReasons: list[HelperBlockedReason] = Field(default_factory=list)
    pausedReason: Literal['thermal', 'battery', 'hours', 'paused', 'off'] | None = None
    temperatureC: float | None = None
    cpuLimitMode: Literal['cgroup', 'duty-cycle'] | None = None


PRESENCE_SAVE_S = 60


def worker_id(agent: dict[str, Any]) -> str:
    return str(agent.get("id") or agent.get("name") or "agent")


def outdated(version: str) -> bool:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(.*)", version)
    if not match:
        return True
    release = tuple(int(match[i]) for i in (1, 2, 3))
    minimum = tuple(map(int, MIN_WORKER_VERSION.split(".")))
    return release < minimum or (release == minimum and bool(match[4]) and not match[4].startswith("+"))


def version_fields(version: str) -> dict[str, str]:
    if outdated(version):
        state = "too-old"
    else:
        release = tuple(map(int, version.split(".")[:2]))
        shipped = tuple(map(int, SHIPPED_WORKER_VERSION.split(".")[:2]))
        state = "update" if release < shipped else "current"
    return {"version": version, "minimumVersion": MIN_WORKER_VERSION, "versionState": state}


class WorkerRecord:
    def __init__(self, *, now: Callable[[], float] = time.time, path: Path | None = None, changes: Changes | None = None):
        self.changes = changes or Changes()
        self.now, self.path = now, path
        self.lock = threading.RLock()
        self._helpers: dict[str, dict[str, Any]] = {}
        self._retired: set[tuple[str, str | None]] = set()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._releasers: list[Callable[[str], None]] = []
        self._reapers: list[Callable[[], None]] = []
        self._last_reap: float | None = None
        self._presence_saved_at: float | None = None
        self._priority: list[Callable[[str], bool]] = []
        self._requirements: dict[str, tuple[str, ...]] = {}
        self._nest_id: str | None = None
        self._nest_since = 0.0
        self.compute = None
        if path:
            source = path if path.exists() else path.with_name("mac-worker.json")
            try:
                data = json.loads(source.read_text())
                if source == path:
                    self._helpers = data.get("helpers", {})
                    self._retired = {tuple(k) for k in data.get("retired", [])}
                else:
                    old = data.get("worker")
                    if old:
                        self._helpers[old["id"]] = {**self._normalise(old), **{k: old.get(k) for k in ("lastSeenAt", "goodbye")}, "speed": {}}
                    for key in data.get("retired", []):
                        self._retired.add(tuple(json.loads(key) if isinstance(key, str) else key))
                    self._save()
            except (OSError, ValueError, TypeError, KeyError):
                pass
        self._prune()
        # A synthetic row belongs to this backend's live runner. Never revive
        # one from disk before the switch and resource limits have been checked.
        self._helpers = {k: v for k, v in self._helpers.items() if not v.get("nest")}
        self._presence_revision = self.expiry_revision()

    def register_nest(self, agent: dict[str, Any]) -> None:
        with self.lock:
            identity = worker_id(agent)
            if self._nest_id is None:
                self._nest_id, self._nest_since = identity, self.now()
            self.seen(agent)
            self._helpers[identity]["nest"] = True
            self._save()

    def remove_nest(self) -> None:
        with self.lock:
            if self._nest_id is not None:
                self._release(self._nest_id)
                self._helpers.pop(self._nest_id, None)
                self._nest_id = None
                self._save()

    @staticmethod
    def _normalise(agent: dict[str, Any]) -> dict[str, Any]:
        # Validate optional capabilities even for callers outside HTTP. Never
        # accept helper-reported speed: only completed results may supply it.
        return AgentIdentity.model_validate(agent).model_dump()

    def _prune(self) -> None:
        expired = [key for key, row in self._helpers.items() if self._expired(row)]
        for key in expired:
            del self._helpers[key]
            self._retired = {entry for entry in self._retired if entry[0] != key}
        if expired:
            self._save()

    def _expired(self, row):
        return row.get('revokedAt') is not None and self.now() - row['revokedAt'] > REVOKED_HISTORY_S

    def maintain(self):
        self.reap()

    def _only_presence(self, old, row) -> bool:
        """A check-in that only refreshes lastSeenAt is not a change anyone sees.

        Every claim and heartbeat used to rewrite the helper file and bump the
        helpers and jobs areas, so each poll of a connected helper invalidated
        Home, jobs and settings for every app. Online/offline transitions still
        surface through expiry_revision on the throttled reap.
        """
        if old is None:
            return False
        ignore = ("lastSeenAt",)
        return ({k: v for k, v in old.items() if k not in ignore}
                == {k: v for k, v in row.items() if k not in ignore})

    def _save_presence(self) -> None:
        """Persist lastSeenAt at most once a minute, without announcing a change."""
        now = self.now()
        if self._presence_saved_at is not None and now - self._presence_saved_at < PRESENCE_SAVE_S:
            return
        self._presence_saved_at = now
        if self.path:
            retired = sorted(self._retired, key=lambda k: (k[0], k[1] or ""))
            write_json_atomic(self.path, {"helpers": self._helpers, "retired": retired}, mode=SHARED)

    def _notify(self) -> None:
        self._presence_revision = self.expiry_revision()
        self.changes.bump('helpers')
        self.changes.bump('jobs')

    def _save(self) -> None:
        if self.path:
            retired = sorted(self._retired, key=lambda k: (k[0], k[1] or ""))
            write_json_atomic(self.path, {"helpers": self._helpers, "retired": retired}, mode=SHARED)
        self._notify()

    def register_reap(self, reap: Callable[[], None]) -> None:
        self._reapers.append(reap)

    def reap(self) -> None:
        with self.lock:
            now = self.now()
            if self._last_reap is not None and now - self._last_reap < 60:
                return
            for reap in self._reapers:
                reap()
            self._last_reap = now
            self._prune()
            self._jobs = {key: job for key, job in self._jobs.items() if job['until'] >= now}
            if self.expiry_revision() != self._presence_revision:
                self._notify()

    def busy(self, identity: str) -> bool:
        with self.lock:
            return any(j["id"] == identity and j["until"] >= self.now() for j in self._jobs.values())

    def record_result(self, identity: str, kind: str, seconds: float, duration: float | None) -> dict[str, Any]:
        with self.lock:
            helper = self._helpers[identity]
            result = self.result_metadata(identity, seconds)
            if duration and duration > 0 and math.isfinite(duration) and math.isfinite(seconds):
                windows = helper.setdefault("speedWindows", {})
                samples = (windows.get(kind, []) + [seconds * 60 / duration])[-20:]
                windows[kind] = samples
                helper.setdefault("speed", {})[kind] = {"samples": len(samples), "medianSecondsPerMinute": median(samples)}
            self._save()
            return result

    def register_priority(self, pending: Callable[[str], bool]) -> None:
        self._priority.append(pending)

    def higher_priority_pending(self, identity: str) -> bool:
        return any(check(identity) for check in self._priority)

    def result_metadata(self, identity: str, seconds: float) -> dict[str, Any]:
        helper = self._helpers[identity]
        return {"worker": identity, "analyzed_by": identity, "helperName": helper['name'],
                "accel": helper["accel"], "version": helper["version"], "seconds": seconds}

    def register_release(self, release: Callable[[str], None]) -> None:
        self._releasers.append(release)

    def _release(self, identity: str) -> None:
        for release in self._releasers:
            release(identity)
        self._jobs = {k: v for k, v in self._jobs.items() if v["id"] != identity}

    def claim_refusal(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        if outdated(agent.get("version") or ""):
            return {"stop": True, "reason": "too-old", "minimum": MIN_WORKER_VERSION}
        return None

    def accepts(self, identity: str | None) -> bool:
        with self.lock:
            row = self._helpers.get(identity)
            return bool(row and row.get("revokedAt") is None)

    def seen(self, agent: dict[str, Any], *, enroll: bool = True) -> bool:
        with self.lock:
            self._prune()
            identity, session = worker_id(agent), agent.get("sessionId")
            old = self._helpers.get(identity)
            if (identity, session) in self._retired or (old and old.get("revokedAt") is not None):
                return False
            if old is None and not enroll:
                return True  # Presence alone cannot enroll a device; its first claim does.
            row = self._normalise(agent)
            history = [h for h in (old or {}).get("recentCapabilities", [])
                       if self.now() - h["unavailableSince"] < ranking.NEST_FALLBACK_AFTER_S]
            capability_keys = ("jobs", "labels", "os", "accel", "memoryBytes")
            if old and self._nest_id and identity != self._nest_id and any(old.get(k) != row.get(k) for k in capability_keys):
                # A real helper may drop a job capability while the nest is
                # waiting. That was eligible presence too, even if its new
                # profile no longer matches the queued row.
                until = min(self.now(), old["lastSeenAt"] if old.get("goodbye")
                            else old["lastSeenAt"] + AGENT_ONLINE_S)
                history.append({**{k: old.get(k) for k in capability_keys},
                                **version_fields(old.get("version") or ""),
                                "state": "offline", "unavailableSince": until})
            if history:
                row["recentCapabilities"] = history
            if old and old.get("sessionId") != session:
                self._retired.add((identity, old.get("sessionId")))
                self._release(identity)
            row["speedWindows"] = (old or {}).get("speedWindows", {})
            if identity == self._nest_id:
                row["nest"] = True
            row.update(id=identity, lastSeenAt=self.now(), goodbye=None, speed=(old or {}).get("speed", {}))
            self._helpers[identity] = row
            if old is None:
                logger.info("helper enrolled id=%s accel=%s", identity, row["accel"])
            if self._only_presence(old, row):
                self._save_presence()
            else:
                self._save()
            return True

    def touch(self, identity: str) -> None:
        with self.lock:
            if self.accepts(identity):
                before = dict(self._helpers[identity])
                self._helpers[identity].update(lastSeenAt=self.now(), goodbye=None)
                if self._only_presence(before, self._helpers[identity]):
                    self._save_presence()
                else:
                    self._save()

    def bye(self, identity: str | None, reason: str, session: str | None = None) -> dict[str, Any]:
        with self.lock:
            if identity is None:
                selected = self.snapshot()
                identity = selected["id"] if selected else None
                if identity is None:
                    return {"stop": False}
            if not self.accepts(identity) or (identity, session) in self._retired:
                return dict(REPLACED)
            if session is not None and self._helpers[identity].get("sessionId") != session:
                return dict(REPLACED)
            self._release(identity)
            self._helpers[identity].update(goodbye="asleep" if reason == "sleep" else "closed", lastSeenAt=self.now(), state="idle")
            self._save()
            return {"stop": False}

    def revoke(self, identity: str) -> None:
        with self.lock:
            self._release(identity)
            if self.compute:
                self.compute.settings.delete_worker(identity)
            if identity in self._helpers:
                self._helpers[identity]["revokedAt"] = self.now()
                self._save()
                logger.info("helper revoked id=%s", identity)

    def working(self, key: str, identity: str, title: str, phase: str | None, *, ttl: float = 600) -> None:
        with self.lock:
            if self.accepts(identity):
                self._jobs[key] = {"id": identity, "title": title, "phase": phase, "until": self.now() + ttl}
                self._notify()

    def finished(self, key: str) -> None:
        with self.lock:
            job = self._jobs.pop(key, None)
            if job:
                self._notify()
            if job and not any(j["id"] == job["id"] for j in self._jobs.values()):
                self._helpers[job["id"]]["state"] = "idle"

    def _online(self, row: dict[str, Any]) -> bool:
        return (row.get("revokedAt") is None and not row.get("goodbye")
                and self.now() - row["lastSeenAt"] <= AGENT_ONLINE_S)

    def expiry_revision(self):
        with self.lock:
            return (tuple((key, self._online(row)) for key, row in self._helpers.items() if not self._expired(row)),
                    tuple(key for key, job in self._jobs.items() if job['until'] >= self.now()))

    def helpers(self) -> list[dict[str, Any]]:
        with self.lock:
            views = []
            for worker in self._helpers.values():
                if self._expired(worker):
                    continue
                job = next((j for j in self._jobs.values() if j["id"] == worker["id"] and j["until"] >= self.now()), None)
                if outdated(worker.get("version") or ""):
                    state = "outdated"
                elif worker.get("revokedAt") is not None:
                    state = "revoked"
                elif worker.get("goodbye"):
                    state = worker["goodbye"]
                elif not self._online(worker):
                    state = "offline"
                else:
                    state = "working" if job or worker.get("state") == "working" else "idle"
                view = {**worker, **version_fields(worker.get("version") or ""), "state": state, "job": {k: job[k] for k in ("title", "phase")} if job and self._online(worker) else None}
                views.append(MacWorker.model_validate(view).model_dump())
            return views

    def scheduling_helpers(self) -> list[dict[str, Any]]:
        """Availability for scheduling, independent of display-state precedence.

        An outdated helper can also be asleep, revoked or offline. Its display
        state must never make it an idle blocker in the pull scheduler.
        """
        with self.lock:
            views = self.helpers()
            for view in views:
                stored = self._helpers[view["id"]]
                if stored.get("revokedAt") is not None:
                    view["state"] = "revoked"
                elif stored.get("goodbye"):
                    view["state"] = stored["goodbye"]
                elif not self._online(stored):
                    view["state"] = "offline"
                elif view["state"] == "outdated":
                    view["state"] = "working" if view["job"] or stored.get("state") == "working" else "idle"
                if view.get("nest"):
                    view["fallbackSince"] = self._nest_since
                else:
                    view["unavailableSince"] = stored["revokedAt"] if stored.get("revokedAt") is not None else (
                        stored["lastSeenAt"] if stored.get("goodbye") else stored["lastSeenAt"] + AGENT_ONLINE_S
                    )
                    view["recentCapabilities"] = stored.get("recentCapabilities", [])
            return views

    def snapshot(self, kind: str = "transcribe") -> dict[str, Any] | None:
        with self.lock:
            views = self.helpers()
            online = [v for v in views if self._online(self._helpers[v["id"]])]
            if not online:
                return max(views, key=lambda v: v["lastSeenAt"], default=None)
            # Stable ties: recent presence, then device id.
            selected = max(online, key=lambda v: (v["lastSeenAt"], v["id"]))
            for view in online:
                if ranking.faster(view, selected, kind):
                    selected = view
            return selected

    def register_needs(self, kind, needs):
        self._requirements[kind] = tuple(needs)

    def capable_helpers(self, kind, helpers):
        return [h for h in helpers if ranking.capable(h, kind, self._requirements.get(kind, ranking.default_needs(kind)))]

    def wait_reason(self, kind: str = "transcribe", needs: list[str] | None = None) -> ranking.WaitReason | None:
        with self.lock:
            return ranking.wait_reason(self.scheduling_helpers(), kind, needs or self._requirements.get(kind, ranking.default_needs(kind)))

    def legacy(self) -> dict[str, Any]:
        with self.lock:
            agents = [{"name": v["name"], "version": v["version"],
                       "platform": self._helpers[v["id"]].get("platform") or "", "lastSeenAt": v["lastSeenAt"],
                       "busy": v["job"] is not None}
                      for v in self.helpers() if self._online(self._helpers[v["id"]])]
            return {"online": bool(agents), "agents": agents}

    def can_claim(self, row, identity):
        if self.compute:
            return self.compute.can_claim(row, identity)
        return ranking.can_claim(self.scheduling_helpers(), identity, row['kind'], row.get('needs', self._requirements.get(row['kind'], ranking.default_needs(row['kind']))),
                                 row['offered_at'], now=self.now())
