from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Setting(BaseModel):
    disabledReason: Literal["no-engine", "no-cgroup", 'memory'] | None = None
    disabledMessage: str | None = None
    key: str
    value: Any
    default: Any
    source: Literal["default", "env", "app"]
    editable: bool
    needsRestart: bool
    secret: bool = False
    kind: Literal["int", "bool", "choice", "path", "text", "list"]
    version: str | None = None
    binarySource: Literal["env", "system", "bundled"] | None = None
    configured: bool | None = None
    min: int | None = None
    max: int | None = None
    suggestedMax: int | None = None
    unit: str | None = None
    choices: list[str] | None = None
    pendingValue: Any = None


class Group(BaseModel):
    id: str
    settings: list[Setting]


class Machine(BaseModel):
    cores: int
    memoryBytes: int
    arch: str
    container: str | None
    cpuLimit: float | None
    memoryLimitBytes: int | None
    suggestedPreset: Literal["light", "normal", "powerful"]
    presets: dict[str, list[int]]
    capacityPresets: dict[str, dict[str, int]] = Field(default_factory=dict)


class RestartState(BaseModel):
    pending: list[str]
    supported: bool
    how: Literal["systemd", "docker", "desktop", "none"]
    command: str | None = None


class Activity(BaseModel):
    downloads: int
    jobs: int
    devicesSeen5min: int


class ServerConfigResponse(BaseModel):
    machine: Machine
    restart: RestartState
    activity: Activity
    groups: list[Group]


class ConfigChanges(BaseModel):
    model_config = ConfigDict(extra="forbid")
    changes: dict[str, Any]


class RestartRequest(BaseModel):
    when: Literal["idle", "now"] = "idle"


class RestartResponse(BaseModel):
    restarting: bool
    when: Literal["idle", "now"]
    command: str | None = None


class UpdateResponse(BaseModel):
    checking: bool
    current: str
    latest: str | None
    skipped: str | None
    updateAvailable: bool
    releaseUrl: str | None
    install: Literal["script", "compose", "unraid", "systemd", "desktop", "unknown"]
    pinned: bool
    command: str | None
    checkedAt: str | None
    lastError: Literal["unreachable", "rate-limited", "no-release", "bad-response"] | None


class SkipUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str


class BackupEntry(BaseModel):
    stamp: str
    size: int
    reason: str
    ok: bool


class BackupsResponse(BaseModel):
    backups: list[BackupEntry]
