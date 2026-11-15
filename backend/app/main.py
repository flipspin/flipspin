import asyncio
import ipaddress
import logging
import os
import shutil
import sys
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse

from app.infra import env_sources

env_sources.capture_environment()

from app.config import APP_VERSION, KROBI_HOME, ConfigManager, log_retired_settings
from app.infra.logging import LoggerConfig
from app.dependencies import DependencyContainer, resolve_identity_tokens
from app.middleware import ErrorHandlingMiddleware, RequestLoggingMiddleware


def _persistent_env_path() -> Path:
    return Path(os.getenv("KROBI_CREDENTIALS_DIR", str(KROBI_HOME / "credentials"))).parent / ".env"


def _load_env() -> None:
    env_sources.load_environment(KROBI_HOME)


def _configure_encoding() -> None:
    if sys.platform != "win32":
        return
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except OSError:
        os.environ["PYTHONIOENCODING"] = "utf-8"


_load_env()
_configure_encoding()

from app.domains.browse import routes as browse_routes
from app.domains.lyrics import routes as lyrics_routes
from app.domains.stems import routes as stems_routes
from app.domains.helpers import routes as helper_routes, compute_routes
from app.domains.jobs import routes as jobs_routes
from app.domains.dashboard import routes as dashboard_routes
from app.domains.downloads import routes as download_routes
from app.domains.metadata import routes as metadata_routes
from app.domains.music import routes as music_routes
from app.domains.music import analysis_routes, scan_routes, tag_routes, match_routes, duplicate_routes, missing_routes
from app.domains.playlists import routes as playlist_routes
from app.domains.transfers import routes as transfer_routes
from app.domains.server import routes as server_routes
from app.domains.system import routes as system_routes
from app.domains.system import secrets_routes
from app.providers import routes as provider_routes
from app.domains.accounts import routes as account_routes
from app.domains.user_library import routes as user_library_routes
from app.domains.subsonic import routes as subsonic_routes
from app.infra.identity import require_api_token
from app.domains.accounts.claim import read_or_create_setup_token
from app.infra.setup_link import make_setup_link
from app.infra.setup_scene import SETUP_SCENE
from app.infra.cors import resolve_cors_settings
from app.infra.progress import attribute_progress
from app import events

try:
    config = ConfigManager.from_env()
except Exception as e:
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)
    logger.critical("Configuration failed: %s. Fix .env or environment and try again.", e)
    sys.exit(1)

LoggerConfig.setup_logging(config.log_dir, config.log_level)
logger = logging.getLogger(__name__)
logger.info("Starting Flipspin")
log_retired_settings(logger)

# Validate every persistent store before routes, claim announcements or workers
# can observe an empty fallback. SystemExit(78) reaches every process entrypoint.
from app.infra.migrations import open_store, validate_claim
from app.infra.jobs.schema import JOBS
from app.infra.instance import read_or_create_instance_id
from app.domains.accounts.identity import TokenStore
from app.domains.user_library.store import UserTrackStore

from app.infra.data_lock import DataLock

# Offline restore and import-time validation must never mutate the same stores.
with DataLock(config.playlist_dir.parent / '.server.lock'):
    validate_claim(config.users_file, config.instance_file, record=True)
    TokenStore(config.users_file, instance_path=config.instance_file).has_users()
    UserTrackStore(config.user_tracks_file)._records()
    read_or_create_instance_id(config.instance_file)
    open_store(config.jobs_file, JOBS).close()



def _maybe_copy_default_songs(cfg) -> None:
    """Copy bundled default song to base_music_dir if it isn't already there."""
    default_songs_path = os.environ.get("KROBI_DEFAULT_SONGS_PATH")
    if not default_songs_path or not Path(default_songs_path).exists():
        return
    base_dir = cfg.base_music_dir
    if not base_dir.exists():
        base_dir.mkdir(parents=True, exist_ok=True)
    src = Path(default_songs_path)
    for item in src.iterdir():
        if item.is_dir():
            dst = base_dir / item.name
            if not dst.exists():
                try:
                    shutil.copytree(item, dst)
                    logger.info("Copied default song album: %s", item.name)
                except OSError as e:
                    logger.warning("Failed to copy default songs: %s", e)


_maybe_copy_default_songs(config)

app = FastAPI(
    title="Flipspin",
    description="Music management and download application",
    version=APP_VERSION,
)

app.state.config = config
app.state.container = DependencyContainer(config)
app.state.identity_resolver = resolve_identity_tokens


@app.exception_handler(RequestValidationError)
async def safe_secret_validation(request: Request, error: RequestValidationError):
    if request.url.path == "/api/claim" or request.url.path.startswith(("/api/server/secrets", "/api/config/genius", "/api/config/spotify")):
        return JSONResponse(status_code=422, content={"detail": [
            {"loc": item["loc"], "type": item["type"], "msg": "Invalid secret request"}
            for item in error.errors()]})
    return await request_validation_exception_handler(request, error)
# Record restart-key values at boot, before any owner can save new ones.
server_routes.get_server_config(app.state.container)


@app.middleware("http")
async def restart_gate(request: Request, call_next):
    from fastapi.responses import JSONResponse

    service = server_routes.get_server_config(request.app.state.container)
    if service.exiting:
        return JSONResponse({"detail": {"code": "restarting"}}, status_code=503, headers={"Retry-After": "5"})
    return await call_next(request)


app.add_middleware(ErrorHandlingMiddleware)
app.add_middleware(RequestLoggingMiddleware)

# Default accepts loopback dev servers, packaged Tauri schemes, and the legacy
# Electron ``null`` origin — required once the backend runs on a different
# machine than its client. See app/infra/cors.py.
_cors = resolve_cors_settings(os.getenv("KROBI_CORS_ORIGINS"))
for _warning in _cors.warnings:
    logger.warning(_warning)
logger.info(
    "CORS allow_origins=%s allow_credentials=%s",
    _cors.allow_origins,
    _cors.allow_credentials,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors.allow_origins,
    allow_credentials=_cors.allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["ETag", "Content-Type", "Content-Length", "Content-Range", "X-Request-ID"],
)
# Auth is attached here, once per router, rather than decorating ~60 endpoints:
# a per-endpoint dependency is a checklist, and a checklist eventually gets a new
# route added to it and forgotten. Routes that must stay open (health, the OAuth
# hops, the LAN share pages) are exempted centrally inside require_api_token, so
# adding a route is closed by default. GET "/" is declared on the app object
# below and therefore keeps no dependency — the container HEALTHCHECK probes it.
_AUTH = [Depends(require_api_token), Depends(attribute_progress)]
app.include_router(events.router, dependencies=_AUTH)
app.include_router(music_routes.router, dependencies=_AUTH)
app.include_router(analysis_routes.router, dependencies=_AUTH)
app.include_router(scan_routes.router, dependencies=_AUTH)
app.include_router(tag_routes.router, dependencies=_AUTH)
app.include_router(missing_routes.router, dependencies=_AUTH)
app.include_router(match_routes.router, dependencies=_AUTH)
app.include_router(duplicate_routes.router, dependencies=_AUTH)
from app.domains.acquisition import routes as acquisition_routes
app.include_router(acquisition_routes.router, dependencies=_AUTH)
from app.domains.acquisition import upload_routes
app.include_router(upload_routes.router, dependencies=_AUTH)
app.include_router(download_routes.router, dependencies=_AUTH)
app.include_router(metadata_routes.router, dependencies=_AUTH)
app.include_router(playlist_routes.router, dependencies=_AUTH)
app.include_router(transfer_routes.router, dependencies=_AUTH)
app.include_router(dashboard_routes.router, dependencies=_AUTH)
app.include_router(browse_routes.router, dependencies=_AUTH)
app.include_router(lyrics_routes.router, dependencies=_AUTH)
app.include_router(stems_routes.router, dependencies=_AUTH)
app.include_router(helper_routes.router, dependencies=_AUTH)
app.include_router(compute_routes.router, dependencies=_AUTH)
app.include_router(compute_routes.helper_router, dependencies=_AUTH)
app.include_router(jobs_routes.router, dependencies=_AUTH)
app.include_router(provider_routes.router, dependencies=_AUTH)
from app.domains.acquisition.sources import routes as source_routes
from app.domains.acquisition.models import AcquisitionError
app.include_router(source_routes.router, dependencies=_AUTH)


@app.exception_handler(AcquisitionError)
async def acquisition_error_response(request: Request, error: AcquisitionError):
    content = {'code': 'no-sources'} if error.reason == 'no-sources' else {'detail': {'reason': error.reason}}
    return JSONResponse(status_code=error.status, content=content)


# Access management is gated twice: _AUTH like everything else, plus an
# owner-role dependency inside the router (app/domains/accounts/routes.py).
app.include_router(account_routes.router, dependencies=_AUTH)
# The per-user library (app/domains/user_library/routes.py). Token-gated like
# every router and deliberately NOT owner-gated: a member managing their own
# library is the whole feature. Sentinel principals are refused inside it.
app.include_router(user_library_routes.router, dependencies=_AUTH)
app.include_router(system_routes.router, dependencies=_AUTH)
app.include_router(secrets_routes.router, dependencies=_AUTH)
app.include_router(server_routes.router, dependencies=_AUTH)
# Not behind _AUTH: Subsonic clients authenticate in the parameters of every
# request (domains/subsonic/auth.py), and fail with a Subsonic error body.
app.include_router(subsonic_routes.router)

from app.plugins import load_plugins

load_plugins(app, _AUTH)

if config.api_token:
    logger.info("API auth ENABLED: every request needs KROBI_API_TOKEN (health excepted).")
elif config.allow_unauthenticated_remote:
    logger.warning(
        "API auth DISABLED for every client (KROBI_ALLOW_UNAUTHENTICATED_REMOTE=true). "
        "Anyone who can reach this port owns the music library. Set KROBI_API_TOKEN."
    )
else:
    logger.info(
        "API auth: no KROBI_API_TOKEN set, so only loopback clients are served. "
        "Set a token to use this backend from another machine."
    )


# One initial announcement, then at most one reminder per ten minutes.
SETUP_REMINDER_SECONDS = 600


def _announce_first_run_claim(cfg) -> bool:
    """Log the setup instructions only while unclaimed; return whether to remind.

    Serialize with the claim so a reminder cannot print a spent code or recreate
    its file after an owner has been created. The token stays on the console and
    in its 0600 file; it never enters file logs or the public status API.
    """
    from app.infra.discovery import backend_port, lan_ipv4_addresses

    try:
        store = app.state.container.get_token_store()
        with store._lock:
            if store.has_users():
                return False
            setup_token = read_or_create_setup_token(cfg.setup_token_file, logger)
            if cfg.require_setup_token:
                addresses = [
                    address for address in lan_ipv4_addresses()
                    if not ipaddress.ip_address(address).is_loopback
                    and not ipaddress.ip_address(address).is_unspecified
                ]
                address = f"http://{addresses[0]}:{backend_port()}" if addresses else "LAN address unavailable"
                link = make_setup_link(address, setup_token) if addresses else "Setup link unavailable: check the LAN address."
                locale = os.getenv("LC_ALL") or os.getenv("LC_CTYPE") or os.getenv("LANG", "")
                scene = SETUP_SCENE if "utf8" in locale.lower().replace("-", "") else ""
                logger.warning(
                    "\n====================================================\n"
                    "%s\n"
                    "  Flipspin is running · %s\n\n"
                    "  %s\n"
                    "  Paste it in Flipspin → Setup link\n"
                    "  Address: %s\n"
                    "  Setup code: %s\n"
                    "====================================================",
                    scene, APP_VERSION, link, address, setup_token,
                    extra={"console_only": True},
                )
                return True
            logger.warning(
                "FIRST RUN: nobody owns this server yet, so ANYONE who can reach this "
                "port can claim it with POST /api/claim and become its owner. Claim it "
                "now. On an untrusted network, set KROBI_REQUIRE_SETUP_TOKEN=true and "
                "restart to require this setup token: %s (also in %s)",
                setup_token,
                cfg.setup_token_file,
                extra={"console_only": True},
            )
    except Exception as e:  # noqa: BLE001 — a bookkeeping file must not block boot
        logger.warning("Could not prepare the first-run claim: %s", e)
    return False


async def _repeat_first_run_claim(cfg) -> None:
    while True:
        await asyncio.sleep(SETUP_REMINDER_SECONDS)
        if not cfg.require_setup_token or not _announce_first_run_claim(cfg):
            return


@app.on_event("startup")
def _start_backups() -> None:
    from app.infra.data_lock import DataLock

    lock = DataLock(app.state.config.playlist_dir.parent / '.server.lock')
    lock.__enter__()
    app.state.server_data_lock = lock
    app.state.container.get_backups().start()


@app.on_event("shutdown")
def _stop_backups() -> None:
    app.state.container.get_backups().stop()
    lock = getattr(app.state, "server_data_lock", None)
    if lock is not None:
        lock.__exit__(None, None, None)
        app.state.server_data_lock = None


@app.on_event("startup")
async def _start_first_run_claim() -> None:
    app.state.setup_reminder = None
    if _announce_first_run_claim(app.state.config):
        app.state.setup_reminder = asyncio.create_task(_repeat_first_run_claim(app.state.config))


@app.on_event("shutdown")
async def _stop_first_run_claim() -> None:
    task = getattr(app.state, "setup_reminder", None)
    if task is not None:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        app.state.setup_reminder = None


logger.info("All routes registered successfully")


@app.get("/", response_model=dict)
async def root():
    return {
        "message": "Flipspin API",
        "version": APP_VERSION,
        "status": "running",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)


@app.on_event("startup")
async def _jobs_startup_sweep():
    from app.infra.jobs_runtime import boot
    container = app.state.container
    container.get_jobs()  # Upgrade receipt columns before reading historical arrivals.
    # boot() applies ledger retention; save old receipts before it can prune them.
    container.get_music_repository().first_seen.backfill()
    boot(container)
    from app.infra.jobs.maintenance import JobMaintenance
    app.state.job_maintenance = JobMaintenance(container.maintain_jobs)
    container.event_loop = asyncio.get_running_loop()
    container.get_source_installer().recover()
    app.state.job_maintenance.start()


@app.on_event("shutdown")
async def _stop_change_streams():
    await app.state.container.change_bus.close()


@app.on_event("shutdown")
def _stop_job_maintenance():
    if maintenance := getattr(app.state, 'job_maintenance', None):
        maintenance.stop()


@app.on_event("startup")
def _playlist_cleanup_startup() -> None:
    from app.domains.playlists.dangling_migration import migrate_dangling_rows

    migrate_dangling_rows(app.state.container.get_playlist_service())


@app.on_event("startup")
def _library_scan_startup() -> None:
    repository = app.state.container.get_music_repository()
    repository.first_seen.backfill()
    app.state.container.get_library_health()
    repository.start_scanner()


@app.on_event("shutdown")
def _library_scan_shutdown() -> None:
    repo = app.state.container._repositories.get('music_repository')
    if repo:
        repo.stop_scanner()


@app.on_event("startup")
def _analysis_startup() -> None:
    app.state.container.get_missing_files()
    app.state.container.get_tag_edits().recover()
    app.state.container.get_analysis_service().startup()


@app.on_event("shutdown")
def _analysis_shutdown():
    service = app.state.container._services.get('analysis_service')
    if service:
        service.stop()


@app.on_event("startup")
def _lyrics_startup_pass() -> None:
    """With auto-fetch on, look for lyrics once the app has settled.

    Registered as a startup handler rather than run at import so a test that
    imports ``app`` does not spawn a worker thread against the real library.
    """
    try:
        app.state.container.get_lyrics_service().startup()
    except Exception as e:  # a lyrics thread must never keep the app from starting
        LoggerConfig.get_logger(__name__).warning("lyrics startup skipped: %s", e)


@app.on_event("startup")
def _prune_orphan_app_passwords() -> None:
    """Remove recoverable copies left behind by older revocations or a crash."""
    container = app.state.container
    live = {device.device_id for user in container.get_token_store().list_users() for device in user.devices}
    container.get_app_password_vault().forget_missing(live)


@app.on_event("startup")
def _prune_orphan_library_rows() -> None:
    """Rows left behind by accounts an older server deleted without their library."""
    try:
        container = app.state.container
        known = {u.user_id for u in container.get_token_store().list_users()}
        pruned = container.get_user_track_store().prune_unknown_users(known)
        if pruned:
            LoggerConfig.get_logger(__name__).info("dropped %d library rows of deleted accounts", pruned)
    except Exception as e:  # noqa: BLE001 — cleanup must never keep the app from starting
        LoggerConfig.get_logger(__name__).warning("orphan library rows not pruned: %s", e)


@app.on_event("startup")
def _start_lan_advertisement() -> None:
    """Announce the nest on the LAN once it has an owner (``app/infra/discovery.py``).

    A startup handler rather than import-time work so importing ``app`` (every
    test) never opens a multicast socket; the advertiser itself runs on a
    background thread and gates on claim state and ``KROBI_ADVERTISE``.
    """
    try:
        app.state.container.get_nest_advertiser().refresh()
    except Exception as e:  # advertising must never keep the app from starting
        LoggerConfig.get_logger(__name__).warning("LAN advertisement skipped: %s", e)


@app.on_event("shutdown")
def _stop_lan_advertisement() -> None:
    """Withdraw the advertisement so the nest does not linger in other machines' lists."""
    try:
        app.state.container.get_nest_advertiser().stop()
    except Exception as e:  # noqa: BLE001
        LoggerConfig.get_logger(__name__).warning("LAN advertisement stop failed: %s", e)


@app.on_event("startup")
def _start_nest_helper() -> None:
    app.state.container.get_nest_helper().refresh()


@app.on_event("shutdown")
def _stop_nest_helper() -> None:
    app.state.container.get_nest_helper().stop()


@app.on_event("startup")
def _start_update_check() -> None:
    app.state.container.get_update_checker().refresh(startup=True)


@app.on_event("shutdown")
def _stop_update_check() -> None:
    app.state.container.get_update_checker().stop()


# Composition belongs here: Inicio combines three public domain views without
# making music, playlists and membership depend on one another.
from pydantic import BaseModel
from app.dependencies import conditional, get_container, get_music_service, get_playlist_service, get_user_track_store
from app.domains.music.schemas import AlbumWithMetadata
from app.domains.playlists.schemas import PlaylistSummary
from app.domains.user_library.schemas import MyLibraryResponse
from app.domains.user_library.scope import get_library_scope
from app.infra.identity import Principal


class HomeSnapshot(BaseModel):
    albums: list[AlbumWithMetadata]
    library: MyLibraryResponse
    playlists: list[PlaylistSummary]


@app.get('/api/me/home', response_model=HomeSnapshot, dependencies=_AUTH)
@conditional(('me:<account>', 'library', 'analysis', 'playlists', 'jobs'))
def home_snapshot(
    principal: Principal = Depends(user_library_routes.require_real_user),
    music=Depends(get_music_service),
    playlists=Depends(get_playlist_service),
    tracks=Depends(get_user_track_store),
    scope=Depends(get_library_scope),
    container=Depends(get_container),
):
    return {
        'albums': music_routes.album_listing(music, scope),
        'library': user_library_routes.library_snapshot(tracks, principal.user_id),
        'playlists': playlist_routes.playlist_listing(playlists, principal, music.config, scope, container),
    }



@app.on_event("shutdown")
def _stop_sources():
    app.state.container.stop_sources()


# Release only after all worker shutdown hooks have finished.
app.router.on_shutdown.remove(_stop_backups)
app.router.on_shutdown.append(_stop_backups)
