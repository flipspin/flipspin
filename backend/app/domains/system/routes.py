import logging
import os
import shutil
import socket
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel

from app.infra.paths import default_music_dir
from app.config import APP_VERSION, ConfigManager
from app.infra import instance as nest_instance
from app.infra import remote_access, host_facts
from app.domains.system import storage
from app.infra.identity import require_local_client, require_owner
from app.infra.identity import Principal, AccountDirectory
from app.infra.instance import read_or_create_instance_id
from app.dependencies import conditional, DependencyContainer, get_config, get_container, get_library_scope, get_token_store
from app.domains.user_library.scope import LibraryScope
from app.exceptions import ValidationError
from app.infra.extensions import ACCEPTED_PROTOCOLS, ExtensionsResponse, builtin_engines, source_extensions
from app.infra import env_sources
from app.infra.build_identity import BUILD_ID
from app.domains.server.routes import get_server_config
from app.utils.path_safety import safe_open_path
from app.providers.secret_settings import change as change_secrets

router = APIRouter(prefix="/api", tags=["configuration"])
logger = logging.getLogger(__name__)

_ALLOWED_BASEDIR_PARENT = Path.home()

# Resolved once: the client polls /api/health in a loop while it waits for a
# (possibly remote) backend, so the handler must stay allocation-cheap.
_HOSTNAME = socket.gethostname()
_ffmpeg_available_cache: dict = {}

# Cache identity per data-directory path: polling must not repeat filesystem
# writes, and relocation must not reuse another directory's identity.
_instance_id_cache: dict = {}


def _instance_id(config: ConfigManager) -> str:
    """This server's id, generating and persisting it on first ask.

    Never raises — see ``app/infra/instance.py``. The handshake must answer even
    when the id could not be stored, because a client that gets no answer at all
    cannot even tell the user what went wrong.
    """
    path = config.instance_file
    key = str(path)
    cached = _instance_id_cache.get(key)
    if cached is None:
        cached = read_or_create_instance_id(path, logger)
        _instance_id_cache[key] = cached
    return cached


def _auth_methods(config: ConfigManager, store: AccountDirectory) -> list:
    """Derive advertised authentication methods from usable accounts and settings.

    Password support is a boolean, never an account count or identity disclosure.
    See docs/DEVELOPER_GUIDE.md#request-authentication.
    """
    methods = ["token"]
    if store.has_password_sign_in():
        methods.append("password")
    if not config.api_token:
        methods.append("local")
        if config.allow_unauthenticated_remote:
            methods.append("anonymous")
    return methods


def _ffmpeg_available(ffmpeg_path: str) -> bool:
    """Whether the configured ffmpeg binary actually exists on this machine.

    ``config.ffmpeg_path`` may be an absolute path (env override / bundled static
    binary) or the bare name ``ffmpeg`` (PATH lookup); ``shutil.which`` handles
    both. Cached per path so health polling doesn't stat the filesystem in a loop.
    """
    cached = _ffmpeg_available_cache.get(ffmpeg_path)
    if cached is None:
        cached = shutil.which(ffmpeg_path) is not None
        _ffmpeg_available_cache[ffmpeg_path] = cached
    return cached


@router.get("/health")
def health(config: ConfigManager = Depends(get_config)):
    """Cheap unauthenticated liveness/readiness probe.

    The desktop client polls this before opening its window, which matters most
    when the backend is remote: a reachable port is not proof the app is usable.
    The extra fields make a remote deployment debuggable without shell access —
    which music root the server actually resolved (it is the *server's* path, not
    the client's) and whether ffmpeg exists there (no ffmpeg means downloads and
    the audio editor fail later, in a much more confusing way).
    """
    music_dir = config.base_music_dir
    return {
        "status": "ok",
        "version": APP_VERSION,
        "hostname": _HOSTNAME,
        "base_music_dir": str(music_dir),
        "base_music_dir_exists": music_dir.is_dir(),
        "ffmpeg_path": config.ffmpeg_path,
        "ffmpeg_available": _ffmpeg_available(config.ffmpeg_path),
    }


@router.get("/extensions", response_model=ExtensionsResponse)
def list_extensions(request: Request, owner: Principal = Depends(require_owner),
                    config: ConfigManager = Depends(get_config)) -> ExtensionsResponse:
    engines = builtin_engines()
    # Availability is observed from the existing nest engine, never by importing ML.
    status = request.app.state.container.get_lyrics_service().engine.status()
    for engine in engines:
        if engine.state != "on":
            continue
        addon = status.get("addons", {}).get(engine.id, {})
        if addon.get("error"):
            engine.state, engine.reason = "failed:installation", "Engine installation failed; see server logs"
        elif addon.get("installing"):
            engine.state, engine.reason = "off", "Engine installation is in progress"
        elif not addon.get("ready"):
            engine.state, engine.reason = "off", "Engine is not ready in the nest"
    registry = request.app.state.container.get_provider_registry()
    with registry._lock:
        sources = source_extensions(config.data_root)
        for source in sources:
            found = registry.get(source.id)
            if source.state == 'on' and found and hasattr(found[1], 'source'):
                supervisor = found[1].source
                source.state, source.reason = supervisor.state, supervisor.reason
                if not registry.is_enabled(source.id):
                    source.state = 'off'
    extensions = engines + sources
    extensions += getattr(request.app.state, "plugin_extensions", [])
    # Ids are shared by all kinds. Refuse ambiguous metadata in the inventory.
    counts = {item.id: sum(other.id == item.id for other in extensions) for item in extensions}
    extensions = [item.model_copy(update={"state": "invalid", "reason": "Duplicate extension id"})
                  if counts[item.id] > 1 else item for item in extensions]
    return ExtensionsResponse(extensions=extensions, accepted=ACCEPTED_PROTOCOLS)


@router.get("/status")
def server_status(
    request: Request,
    config: ConfigManager = Depends(get_config),
    store: AccountDirectory = Depends(get_token_store),
):
    # Keep the published OpenAPI description byte-stable, including legacy path references.
    """The handshake: *who are you, and how do I talk to you?*

    ``/api/health`` answers "something is alive here". That was never enough for
    the question the desktop client actually has when it finds port 8000 busy:
    is that **my** server, a second copy of me, or an orphan from a crash? It
    used to answer by starting another server on the next free port, so two
    processes ended up writing the same library and no request could say which
    one it had reached.

    ``instanceId`` ends that. It names the *data directory*, survives restarts
    and a change of port, and lets a client that recorded it adopt a running
    server instead of spawning a rival. See ``app/core/instance.py``.

    ``name`` is what this server is called — «el nido» in the clients' words:
    the name set at claim time or by an owner (``PUT /api/server/name``), else
    ``Nido de <hostname>``. ⚠ Never an account label: this body is public and
    names nobody (see ``app/core/instance.py``).

    ``isInit`` tells a fresh client whether this household has anybody in it yet,
    so it can offer "claim this server" instead of an unexplained 401 — the
    first-run state is a normal state, not an error. ``POST /api/claim`` is what
    that offer leads to, and ``setupTokenRequired`` (below) says whether the
    setup screen has to ask for a secret first.

    ⚠ **Additive only.** An iOS client and a desktop client are built against
    this body and pinned by ``tests/integration/test_response_contracts.py``. A
    new key is free; a renamed or removed one breaks a shipped app that cannot
    be updated in step with the server it points at.

    Unauthenticated on purpose (``PUBLIC_EXACT_PATHS``): a client must be able to
    ask who this is *before* it holds any credential. That constraint is also why
    the payload is deliberately thin — nothing here describes the library, and
    the nest's other addresses live on the authenticated ``/api/server/network``.

    CORS follows the configured allow list for Tauri and Vite dev origins.
    """
    is_init = store.has_users()
    payload = {
        "restarting": get_server_config(request.app.state.container).restarting,
        "plugins": list(getattr(request.app.state, "plugins", [])),
        "app": "krobi",
        "version": APP_VERSION,
        "buildId": BUILD_ID,
        "instanceId": _instance_id(config),
        "name": nest_instance.get_name(config.instance_file),
        "pid": os.getpid(),
        "isInit": is_init,
        "authMethods": _auth_methods(config, store),
        # Whether the first-run wizard was finished. Unrecorded means a server
        # from before the wizard: done once claimed, so nobody is sent back
        # through it (``core/instance.py::read_setup_done``).
        "setupDone": _setup_done(config, is_init),
    }
    # Only before the household exists. A first-run client has a real need for
    # it — it shows the user where their data is about to land, and there is
    # nothing yet to protect. Once somebody has claimed the server, this route is
    # still answered without a credential, and a configured server volunteering
    # its filesystem layout to any stranger who can reach the port is a free
    # reconnaissance gift (usernames live in home directory paths). So it goes
    # away the moment it stops being useful.
    if not is_init:
        payload["dataDir"] = str(config.data_root)
        # Publish setup-token requirements only while claiming is possible.
        # Older servers omit this key; clients interpret omission as no token required.
        payload["setupTokenRequired"] = bool(config.require_setup_token)
    return payload


def _setup_done(config: ConfigManager, is_init: bool) -> bool:
    stored = nest_instance.read_setup_done(config.instance_file)
    return is_init if stored is None else stored


class SetupStateRequest(BaseModel):
    """``PUT /api/server/setup``."""

    done: bool


class SetupStateResponse(BaseModel):
    setupDone: bool


@router.put("/server/setup", response_model=SetupStateResponse)
def set_setup_state(
    body: SetupStateRequest,
    config: ConfigManager = Depends(get_config),
    owner: Principal = Depends(require_owner),
) -> dict:
    """Mark the first-run wizard finished (or not). Owner-only.

    Kept on the server, not in a client: the wizard runs once per nest, and a
    second computer or a browser joining a set-up nest must not run it again.
    """
    try:
        done = nest_instance.set_setup_done(config.instance_file, body.done, logger)
    except OSError as e:
        logger.warning("Could not store the setup state in %s: %s", config.instance_file, e)
        raise HTTPException(status_code=500, detail="Could not store the setup state.") from e
    logger.info("First-run wizard marked %s by %s", "done" if done else "pending", owner.user_id)
    return {"setupDone": done}


class LibrarySummaryResponse(BaseModel):
    folder: str
    songs: int
    albums: int
    artists: int


@router.get("/library/summary", response_model=LibrarySummaryResponse)
@conditional(('library', 'analysis'))
def library_summary(
    container: DependencyContainer = Depends(get_container),
    scope: LibraryScope = Depends(get_library_scope),
) -> dict:
    """What the library holds, counted: the first-run wizard's music step.

    One scan, the same memoized one the listing uses. ``artists`` counts album
    artists, case- and accent-insensitively.
    """
    def fold(text: str) -> str:
        decomposed = unicodedata.normalize("NFKD", text or "")
        return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold().strip()

    repo = container.get_music_repository()
    albums = scope.filter_albums(repo.scan_albums(), repo.config.base_music_dir)
    return {
        "folder": str(repo.config.base_music_dir),
        "songs": sum(len(a.tracks) for a in albums),
        "albums": len(albums),
        "artists": len({fold(a.artist) for a in albums if a.artist}),
    }


class ServerNameRequest(BaseModel):
    """``PUT /api/server/name``. Validated by ``instance.clean_nest_name``."""

    name: str


class ServerNameResponse(BaseModel):
    name: str


@router.put("/server/name", response_model=ServerNameResponse)
def set_server_name(
    body: ServerNameRequest,
    config: ConfigManager = Depends(get_config),
    container: DependencyContainer = Depends(get_container),
    owner: Principal = Depends(require_owner),
) -> dict:
    """Rename the nest. Owner-only.

    The name lives beside the instance id in ``instance.json`` and is served by
    ``GET /api/status`` and the LAN advertisement, which is re-registered here so
    other machines see the new name without a restart. ``422`` for an empty,
    over-long (> 60) or control-character name.
    """
    try:
        name = nest_instance.set_name(config.instance_file, body.name, logger)
    except nest_instance.InvalidNestNameError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except OSError as e:
        logger.warning("Could not store the nest name in %s: %s", config.instance_file, e)
        raise HTTPException(status_code=500, detail="Could not store the name.") from e
    logger.info("Nest renamed to %r by %s", name, owner.user_id)
    try:
        container.get_nest_advertiser().refresh()
    except Exception as e:  # noqa: BLE001 — the rename itself has succeeded
        logger.warning("Could not refresh the LAN advertisement after a rename: %s", e)
    return {"name": name}


class TailscaleAddressModel(BaseModel):
    ip: str
    name: str | None
    url: str


RemoteRoute = Literal["tailscale", "wireguard", "domain", "local"]


class OutsideVisitModel(BaseModel):
    at: str
    via: Literal["vpn", "tailscale", "proxy"]


class ServerNetworkResponse(BaseModel):
    lan: list[str]
    #: Each private network a ``lan`` address sits on, CIDR with the interface's real
    #: prefix (``192.0.2.0/24``). Empty when unknown, and on nests older than this field.
    lanNetworks: list[str] = []
    tailscale: TailscaleAddressModel | None
    externalUrl: str | None
    route: RemoteRoute | None = None
    outside: OutsideVisitModel | None = None


@router.get("/server/network", response_model=ServerNetworkResponse)
def server_network(config: ConfigManager = Depends(get_config)) -> dict:
    # Keep the published OpenAPI description byte-stable, including legacy path references.
    """Every address this nest can be reached at: local, Tailscale, domain.

    Clients refresh their copy on every successful connection and, when the
    address they were set up with stops answering, try the others in order
    (``contracts/remote-access.json`` → ``pick``), keeping whichever answers
    ``/api/status`` with this nest's ``instanceId``. See
    ``app/core/remote_access.py``.

    Any signed-in principal, members included: a member's phone away from home
    needs the Tailscale address exactly as much as the owner's does.

    ⚠ **Deliberately not on ``/api/status``** and not in ``PUBLIC_EXACT_PATHS``.
    The handshake answers anyone who can reach the port; the domain, the
    tailnet name and the list of interfaces together are a map of where this
    deployment lives. A client only needs them once it holds a credential.
    """
    snapshot = remote_access.network_snapshot()
    tailscale = snapshot.tailscale
    return {
        "lan": snapshot.lan,
        "lanNetworks": snapshot.lan_networks,
        "tailscale": (
            {"ip": tailscale.ip, "name": tailscale.name, "url": tailscale.url}
            if tailscale is not None
            else None
        ),
        "externalUrl": nest_instance.read_external_url(config.instance_file),
        "route": nest_instance.read_remote_route(config.instance_file),
        "outside": nest_instance.read_outside(config.instance_file),
    }


class RemoteRouteRequest(BaseModel):
    route: object = None


class RemoteRouteResponse(BaseModel):
    route: RemoteRoute


@router.put("/server/remote-route", response_model=RemoteRouteResponse)
def set_remote_route(
    body: RemoteRouteRequest,
    config: ConfigManager = Depends(get_config),
    owner: Principal = Depends(require_owner),
) -> dict:
    if body.route not in nest_instance.REMOTE_ROUTES:
        raise HTTPException(status_code=422, detail="unknown-route")
    return {"route": nest_instance.set_remote_route(config.instance_file, body.route)}


@router.get("/server/host", response_model=host_facts.HostFacts, response_model_exclude_unset=True)
def server_host(
    owner: Principal = Depends(require_owner),
    container: DependencyContainer = Depends(get_container),
) -> host_facts.HostFacts:
    """Owner-only deployment facts; unavailable probes remain null."""
    facts = host_facts.snapshot(lambda: container.get_lyrics_service().engine_mode)
    try:
        latest = container.get_backups().latest()
    except OSError:
        # Keep host facts available; an absent optional value means unknown.
        return facts
    facts.lastBackupAt = None
    facts.lastBackupReason = None
    if latest:
        from app.infra.backups import stamp_time
        facts.lastBackupAt = stamp_time(latest['stamp'])
        facts.lastBackupReason = latest['reason']
    return facts


class DiskModel(BaseModel):
    total: int
    free: int


class ServerStorageResponse(BaseModel):
    dataRoot: str
    disk: DiskModel
    music: int
    stems: int
    other: int


@router.get("/server/storage", response_model=ServerStorageResponse)
def server_storage(
    config: ConfigManager = Depends(get_config),
    owner: Principal = Depends(require_owner),
) -> dict:
    """The data disk, split: music · stems · the rest, in bytes. Owner-only.

    ``disk`` is ``shutil.disk_usage`` of the resolved data root; ``music`` and ``stems`` are summed by a
    walk cached ~5 min (``storage.py``); ``other`` is used − music − stems,
    floored at 0. Owner-only like the rest of the nest's admin: a member has no
    use for the server's disk and its size is a deployment fingerprint.
    """
    data_dir = config.data_root
    try:
        return {"dataRoot": str(data_dir), **storage.storage_snapshot(data_dir, Path(config.base_music_dir), Path(config.stems_dir))}
    except OSError as e:
        logger.warning("Could not read the disk usage of %s: %s", data_dir, e)
        raise HTTPException(status_code=500, detail="Could not read the disk usage.") from e


class ExternalUrlRequest(BaseModel):
    """``PUT /api/server/external-url``. ``null`` or ``""`` clears it."""

    url: str | None


class ExternalUrlResponse(BaseModel):
    externalUrl: str | None


@router.put("/server/external-url", response_model=ExternalUrlResponse)
def set_external_url(
    body: ExternalUrlRequest,
    config: ConfigManager = Depends(get_config),
    owner: Principal = Depends(require_owner),
) -> dict:
    """Store the HTTPS domain in front of this nest. Owner-only.

    Normalised by ``remote_access.normalise_external_url`` — the server is
    authoritative and runs the shared contract cases. ``422`` with ``detail``
    = the bare reason code (``needs-https``, ``has-path``, ``has-credentials``,
    ``not-a-url``), never prose: each client maps the code to its own words.

    The server does not probe the domain. Checking it is the client's job,
    from where the person is — a domain checked from inside the LAN can fail on
    hairpin NAT and still work outside, which is why an owner may save one that
    did not answer.
    """
    try:
        url = nest_instance.set_external_url(config.instance_file, body.url, logger)
    except remote_access.ExternalUrlError as e:
        raise HTTPException(status_code=422, detail=e.code) from e
    except OSError as e:
        logger.warning("Could not store the external URL in %s: %s", config.instance_file, e)
        raise HTTPException(status_code=500, detail="Could not store the address.") from e
    logger.info("External URL %s by %s", "set" if url else "cleared", owner.user_id)
    return {"externalUrl": url}


@router.get("/ping")
def ping():
    """Reachability check that leaves a trace in the log.

    Exists purely for the human debugging "can this machine even reach the
    backend?". ``/api/health`` deliberately stays silent and allocation-cheap
    because clients poll it in a loop — logging a line per poll would bury every
    other message in the file. This one is only ever hit by hand, so it can
    afford to say it was hit, which is the entire point: the answer arrives in
    the log the user is already reading rather than only in a terminal they may
    not have.
    """
    logger.info("Ping received")
    return {"success": True}


class BaseDirRequest(BaseModel):
    basedir: str


class SpotifyConfigRequest(BaseModel):
    client_id: str = ""
    client_secret: str = ""


class YtdlpCookiesRequest(BaseModel):
    # Browser name source reads cookies from (chrome/safari/firefox/brave/edge/…).
    # Empty disables cookie auth. cookies_file is the manual cookies.txt fallback.
    cookies_from_browser: str = ""
    cookies_file: str = ""


class AnalysisTagsRequest(BaseModel):
    # When true, background analysis writes detected BPM/key back into file tags.
    write_analysis_tags: bool = False


def _default_basedir() -> Path:
    """Default music directory: KROBI_MUSIC_DIR, else the install's default."""
    return default_music_dir().resolve()


# Local-only: this mutates app.state.config for EVERY caller, and the path it
# accepts is validated against the *server's* $HOME, so a remote client can only
# ever pass a path that is wrong on both counts. LibraryContext already skips it
# in remote mode; this is the backend saying so itself.
@router.post("/set-basedir", dependencies=[Depends(require_owner), Depends(require_local_client)])
@env_sources.settings_write
def set_basedir(data: BaseDirRequest, config: ConfigManager = Depends(get_config)):
    env_sources.require_unlocked("KROBI_MUSIC_DIR")
    # Resolve symlinks before accepting the home or selected data root.
    try:
        base = Path(data.basedir).expanduser().resolve()
        if not base.is_absolute():
            raise ValidationError("Base directory must be an absolute path")
        parents = (_ALLOWED_BASEDIR_PARENT.resolve(), config.data_root.resolve())
        if not any(base.is_relative_to(parent) for parent in parents):
            raise ValidationError(
                "Base directory must be under your home directory or data root",
                details={"allowed_parent": str(_ALLOWED_BASEDIR_PARENT),
                         "allowed_parents": [str(parent) for parent in parents]},
            )
        if not base.exists():
            base.mkdir(parents=True, exist_ok=True)
        if not base.is_dir():
            raise ValidationError("Path is not a directory")
        env_sources.persist(config.data_root / ".env", {"KROBI_MUSIC_DIR": str(base)})
        config.base_music_dir = base
        logger.info("Base directory set to %s", base)
        return {"success": True, "basedir": str(base)}
    except (ValidationError, HTTPException):
        raise
    except Exception as e:
        logger.exception("Error setting basedir")
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/get-basedir")
def get_basedir(config: ConfigManager = Depends(get_config)):
    return {"basedir": str(config.base_music_dir)}


@router.get("/get-default-basedir")
def get_default_basedir():
    return {"default_basedir": str(_default_basedir())}


# Local-only for the same reason as set-basedir, and it is the destructive half:
# one unauthenticated POST repoints a whole server's library at <root>/Music.
@router.post("/reset-basedir", dependencies=[Depends(require_owner), Depends(require_local_client)])
@env_sources.settings_write
def reset_basedir(config: ConfigManager = Depends(get_config)):
    env_sources.require_unlocked("KROBI_MUSIC_DIR")
    default = config.data_root / "Music"
    default.mkdir(parents=True, exist_ok=True)
    env_sources.persist(config.data_root / ".env", {"KROBI_MUSIC_DIR": str(default)})
    config.base_music_dir = default
    logger.info("Base directory reset to %s", default)
    return {"success": True, "basedir": str(default)}


@router.get("/config/spotify")
def get_spotify_config(config: ConfigManager = Depends(get_config)):
    """Return whether Spotify credentials are configured (no secrets)."""
    return {"configured": bool(config.spotify_client_id and config.spotify_client_secret)}


def _is_keep_value(v: str) -> bool:
    """Treat empty or masked value as 'keep existing' when updating .env."""
    return not v or v.strip() == "" or v.strip() == "••••••••"


@router.put("/config/spotify", dependencies=[Depends(require_owner)])
@env_sources.settings_write
def put_spotify_config(data: SpotifyConfigRequest, config: ConfigManager = Depends(get_config),
                       principal: Principal = Depends(require_owner)):
    """Compatibility settings route, backed by the nest's secret store."""
    values = {name: value for name, value in (("SPOTIFY_CLIENT_ID", data.client_id),
                                              ("SPOTIFY_CLIENT_SECRET", data.client_secret))
              if not _is_keep_value(value)}
    change_secrets(config, values, actor=principal.user_id)
    return {"success": True, "message": "Guardado. Reinicia la app para que los cambios tengan efecto."}


@router.get("/config/ytdlp-cookies")
def get_ytdlp_cookies_config(config: ConfigManager = Depends(get_config)):
    """Current source cookie settings (not secret — just a browser name / path)."""
    return {
        "cookies_from_browser": config.source_cookies_from_browser or "",
        "cookies_file": config.source_cookies_file or "",
    }


# Browsers source's --cookies-from-browser understands. Validated so a typo
# can't get baked into a source arg that fails every download.
_ALLOWED_COOKIE_BROWSERS = {
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
}


@router.put("/config/ytdlp-cookies", dependencies=[Depends(require_owner)])
@env_sources.settings_write
def put_ytdlp_cookies_config(data: YtdlpCookiesRequest, config: ConfigManager = Depends(get_config)):
    """Persist source cookies to the nest's settings file and apply them live.

    Takes effect immediately for new downloads (the repository reads config at
    call time); the .env write makes it survive restarts.
    """
    env_sources.require_unlocked("KROBI_YTDLP_COOKIES_FROM_BROWSER", "KROBI_YTDLP_COOKIES_FILE")
    browser = (data.cookies_from_browser or "").strip().lower()
    cookies_file = (data.cookies_file or "").strip()
    if browser and browser not in _ALLOWED_COOKIE_BROWSERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported browser '{browser}'. Choose one of: {', '.join(sorted(_ALLOWED_COOKIE_BROWSERS))}.",
        )
    if cookies_file:
        # Store the expanded absolute path: the file is read by the backend
        # process, so "~" must resolve against the *server's* home, and a remote
        # backend can only see files that exist on the server.
        resolved_cookies = Path(cookies_file).expanduser()
        if not resolved_cookies.is_file():
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cookies file not found: {cookies_file}. The path must exist on the "
                    "machine running the backend."
                ),
            )
        cookies_file = str(resolved_cookies)

    env_sources.persist(config.data_root / ".env", {
        "KROBI_YTDLP_COOKIES_FROM_BROWSER": browser, "KROBI_YTDLP_COOKIES_FILE": cookies_file,
    })
    config.source_cookies_from_browser = browser or None
    config.source_cookies_file = cookies_file or None
    return {"success": True, "cookies_from_browser": browser, "cookies_file": cookies_file}


@router.get("/config/analysis-tags")
def get_analysis_tags_config(config: ConfigManager = Depends(get_config)):
    """Whether detected BPM/key are written back into music files (opt-in)."""
    return {"write_analysis_tags": bool(config.write_analysis_tags)}


@router.put("/config/analysis-tags", dependencies=[Depends(require_owner)])
@env_sources.settings_write
def put_analysis_tags_config(data: AnalysisTagsRequest, config: ConfigManager = Depends(get_config)):
    """Persist the tag write-back toggle to <root>/.env and apply it live.

    Takes effect immediately (background analysis reads config at run time); the
    .env write makes the choice survive restarts.
    """
    enabled = bool(data.write_analysis_tags)
    env_sources.persist(config.data_root / ".env", {
        "KROBI_WRITE_ANALYSIS_TAGS": "true" if enabled else "false",
    })
    config.write_analysis_tags = enabled
    return {"success": True, "write_analysis_tags": enabled}


# Local-only: this launches a GUI application on the machine running the backend.
# On a headless server it is at best a no-op and at worst a way to make the box
# spawn processes; nobody is sitting in front of that screen anyway.
@router.post("/open-file", dependencies=[Depends(require_owner), Depends(require_local_client)])
def open_file(path: str = Body(..., embed=True), config: ConfigManager = Depends(get_config)):
    # only under music dir
    try:
        candidate = Path(path).expanduser().resolve()
        file_path = safe_open_path(config.base_music_dir, candidate)
        if not file_path.is_file():
            raise ValidationError("Path is not a file")
        if sys.platform == "win32":
            os.startfile(str(file_path))
        elif sys.platform == "darwin":
            subprocess.run(["open", str(file_path)], check=True)
        else:
            subprocess.run(["xdg-open", str(file_path)], check=True)
        logger.info("Opened file %s", file_path.name)
        return {"success": True, "message": f"Opened {file_path.name}"}
    except ValidationError:
        raise
    except subprocess.CalledProcessError as e:
        logger.error("Failed to open file: %s", e)
        raise HTTPException(status_code=500, detail="Failed to open file") from e
    except Exception as e:
        logger.exception("Unexpected error opening file")
        raise HTTPException(status_code=500, detail="Internal server error") from e


# ---------------------------------------------------------------------- logs
#
# A log viewer is one careless `?file=` away from being an arbitrary-file
# reader, so the name is resolved through a fixed allowlist rather than joined
# onto a path. `safe_open_path` guards the result as well — belt and braces,
# because this endpoint hands file contents back to a caller.
LOG_FILES = {
    "app": "krobi.log",
    "errors": "krobi_errors.log",
}

#: Hard ceiling on a single response. `krobi.log` rotates at 10 MB, and reading
#: it whole would be a slow request that ends in an unreadable wall of text.
MAX_LOG_LINES = 2000
DEFAULT_LOG_LINES = 300


class ClearLogRequest(BaseModel):
    file: str


class ClearLogResponse(BaseModel):
    file: str
    clearedBytes: int


@router.post("/logs/clear", response_model=ClearLogResponse)
def clear_logs(
    body: ClearLogRequest,
    owner: Principal = Depends(require_owner),
    config: ConfigManager = Depends(get_config),
    store: AccountDirectory = Depends(get_token_store),
) -> ClearLogResponse:
    """Clear the current allowlisted log in place, preserving rotated files."""
    name = LOG_FILES.get(body.file)
    if name is None:
        raise HTTPException(status_code=422, detail="Unknown log file")
    candidate = config.log_dir / name
    try:
        path = safe_open_path(config.log_dir, candidate)
        if candidate.is_symlink() or not path.is_file():
            raise ValueError("Invalid log file")
    except Exception:
        raise HTTPException(status_code=404, detail="Log file is not writable")
    try:
        # Never replace the inode: existing logging handlers keep their stream.
        with path.open("r+b") as stream:
            cleared = os.fstat(stream.fileno()).st_size
            stream.truncate(0)
    except OSError:
        raise HTTPException(status_code=500, detail="Could not clear the log file")
    account = store.get_user(owner.user_id) if owner.device_id else None
    device = account.device(owner.device_id) if account and owner.device_id else None
    device_name = device.label if device else owner.label
    logger.info("Log cleared (%s) by %s", body.file, device_name.replace("\n", " ").replace("\r", " "))
    return ClearLogResponse(file=body.file, clearedBytes=cleared)

#: How far back from the end of the file to read. Enough to satisfy
#: MAX_LOG_LINES of typical log lines without ever loading a 10 MB file.
_TAIL_BYTES = 1_500_000


def _tail_lines(path: Path, limit: int) -> tuple[list, bool]:
    """Last `limit` lines of a file, without reading the whole thing.

    Returns (lines, truncated) where `truncated` means the file had more before
    the read window. Seeking from the end matters: the interesting part of a
    log is always the end, and `krobi.log` is routinely megabytes.
    """
    size = path.stat().st_size
    with path.open("rb") as fh:
        start = max(0, size - _TAIL_BYTES)
        fh.seek(start)
        chunk = fh.read()
    text = chunk.decode("utf-8", errors="replace")
    if start > 0:
        # The first line is probably a fragment; drop it rather than show half
        # a line as if it were a record.
        text = text.split("\n", 1)[-1]
    lines = [ln for ln in text.splitlines() if ln.strip()]
    truncated = start > 0 or len(lines) > limit
    return lines[-limit:], truncated


@router.get("/logs", dependencies=[Depends(require_owner)])
def read_logs(
    file: str = "app",
    lines: int = DEFAULT_LOG_LINES,
    level: str = "",
    q: str = "",
    config: ConfigManager = Depends(get_config),
):
    """Tail a backend log.

    Powers Ajustes → Registro. Deliberately read-only and allowlisted: `file` is
    a key into LOG_FILES, never a path fragment.

    `errors` is JSON per line and `app` is prose, so the shape of a record
    differs; both are returned as raw text plus a best-effort parse, and the UI
    renders whichever it got. Filtering happens here rather than in the browser
    because the whole point is to avoid shipping megabytes to it.
    """
    name = LOG_FILES.get(file)
    if name is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown log '{file}'. Expected one of: {', '.join(sorted(LOG_FILES))}.",
        )
    limit = max(1, min(int(lines), MAX_LOG_LINES))

    candidate = config.log_dir / name
    if not candidate.exists():
        # A log that has not been written yet is not an error — a fresh install
        # has no errors log until something fails.
        return {
            "file": file,
            "path": str(candidate),
            "lines": [],
            "truncated": False,
            "sizeBytes": 0,
            "matched": 0,
            "scanned": 0,
        }

    # Checked only once the file exists, because `safe_open_path` validates an
    # *existing* path. `name` came from LOG_FILES, so this is belt-and-braces
    # rather than the primary defence — but it is the check standing between a
    # symlinked log file and an arbitrary read, so it stays.
    try:
        path = safe_open_path(config.log_dir, candidate)
    except Exception:
        raise HTTPException(status_code=404, detail="Log file is not readable")

    # Scan a wide window and return up to `limit` *matches*, rather than
    # filtering `limit` lines. "Filter the log" should mean the log, not the
    # last 300 lines of it — searching for "source" and being told "0 de 300"
    # because the tail happens to be middleware chatter is a useless answer.
    try:
        raw, truncated = _tail_lines(path, MAX_LOG_LINES)
    except OSError as e:
        logger.warning("Could not read log %s: %s", path, e)
        raise HTTPException(status_code=500, detail="Could not read the log file")

    wanted_level = (level or "").strip().upper()
    needle = (q or "").strip().lower()
    out = []
    for line in raw:
        if needle and needle not in line.lower():
            continue
        if wanted_level and wanted_level not in line.upper():
            continue
        out.append(line)

    matched = len(out)
    return {
        "file": file,
        "path": str(path),
        # Newest last, so the tail of the list is the tail of the log.
        "lines": out[-limit:],
        "truncated": truncated or matched > limit,
        "sizeBytes": path.stat().st_size,
        "matched": matched,
        "scanned": len(raw),
    }
