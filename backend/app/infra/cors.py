"""Resolve CORS for direct browser requests and packaged desktop origins.

Rust-proxied requests have no browser Origin; HTTP fallbacks still need CORS.
Opaque null origins require explicit opt-in. Wildcard origins disable credentials
because browsers reject that combination otherwise.
"""
from dataclasses import dataclass, field

# Opaque browser origins, accepted only when explicitly configured.
NULL_ORIGIN = "null"
TAURI_ORIGINS = (
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
)

DEFAULT_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    *TAURI_ORIGINS,
)


@dataclass
class CorsSettings:
    """Resolved arguments for Starlette's ``CORSMiddleware``."""

    allow_origins: list[str]
    allow_credentials: bool
    warnings: list[str] = field(default_factory=list)


def resolve_cors_settings(raw: str | None) -> CorsSettings:
    """Honor explicit origins while keeping wildcard policies valid.

    Blank uses desktop/dev defaults with credentials. Wildcards disable credentials;
    explicit lists without Tauri origins emit a warning about packaged requests.
    """
    origins = [o.strip() for o in (raw or "").split(",") if o.strip()]
    if not origins:
        return CorsSettings(allow_origins=list(DEFAULT_ORIGINS), allow_credentials=True)

    if "*" in origins:
        return CorsSettings(
            allow_origins=["*"],
            allow_credentials=False,
            warnings=[
                "KROBI_CORS_ORIGINS contains '*': allowing any origin and disabling "
                "allow_credentials ('*' with credentials is rejected by browsers). "
                "CORS is not this backend's access control — KROBI_API_TOKEN is "
                "(app/domains/accounts/auth.py). Keep it on a trusted LAN/VPN either way."
            ],
        )

    # De-duplicate while preserving the configured order.
    deduped: list[str] = []
    for origin in origins:
        if origin not in deduped:
            deduped.append(origin)

    warnings: list[str] = []
    missing_tauri = [origin for origin in TAURI_ORIGINS if origin not in deduped]
    if missing_tauri:
        warnings.append(
            "KROBI_CORS_ORIGINS is missing packaged Tauri origin(s): "
            f"{', '.join(missing_tauri)}. Direct media, progress-stream, and "
            "library requests may be blocked."
        )
    return CorsSettings(allow_origins=deduped, allow_credentials=True, warnings=warnings)
