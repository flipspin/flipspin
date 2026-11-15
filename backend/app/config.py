import os
from pathlib import Path

# Re-exported so callers can keep importing ConfigurationError from app.config.
# It must be the same class the middleware catches (app.exceptions), otherwise a
# config-validation failure falls through to the generic 500 handler instead of
# being mapped to a 503.
from app.infra.capacity import CapacityLimiter
from app.infra.ffmpeg import resolve_ffmpeg as resolve_ffmpeg, resolve_ffmpeg_info
from app.exceptions import ConfigurationError
from app.infra.secrets import SecretStore, apply_to_config
from app.infra import env_sources

# Single source of truth for the API version reported by ``/`` and ``/api/health``
# (and used as the FastAPI app version).
APP_VERSION = "0.1.0-rc.16"  # keep in sync with package.json; GET /api/health reports it

# The one data directory every default hangs off: music, playlists, logs, the
# persisted .env, caches, tools and models. Nothing else spells this path out.
KROBI_HOME = Path.home() / "Krobi"


# The five directories every install needs, as constructor kwarg → (env var,
# name under KROBI_HOME). ``from_env`` creates them; ``validate`` refuses to
# start without them.
REQUIRED_DIRS: dict[str, tuple[str, str]] = {
    "base_music_dir": ("KROBI_MUSIC_DIR", "Music"),
    "playlist_dir": ("KROBI_PLAYLIST_DIR", "playlists"),
    "temp_dir": ("KROBI_TEMP_DIR", "temp"),
    "log_dir": ("KROBI_LOG_DIR", "logs"),
    "credentials_dir": ("KROBI_CREDENTIALS_DIR", "credentials"),
}

# State files and folders, same shape. The constructor defaults each one beside
# ``playlist_dir`` (see ``_init_state_paths``); ``from_env`` reads them here.
# Every entry must reach the constructor: ``KROBI_USER_TRACKS_FILE`` was once
# read and then dropped, and nothing noticed because the constructor's fallback
# happened to be the same path. An ignored ``KROBI_INSTANCE_FILE`` would be
# quieter still — a relocated data directory would keep introducing itself with
# the default one's id — and a setup token written to the default path would
# guard a household it is not beside. One table feeding both sides is what
# keeps them in step.
STATE_PATHS: dict[str, tuple[str, str]] = {
    "providers_file": ("KROBI_PROVIDERS_FILE", "providers.json"),
    "users_file": ("KROBI_USERS_FILE", "users.json"),
    "user_tracks_file": ("KROBI_USER_TRACKS_FILE", "user_tracks.json"),
    "update_check_file": ("KROBI_UPDATE_CHECK_FILE", "update-check.json"),
    "instance_file": ("KROBI_INSTANCE_FILE", "instance.json"),
    "setup_token_file": ("KROBI_SETUP_TOKEN_FILE", "setup-token"),
    "lyrics_file": ("KROBI_LYRICS_FILE", "lyrics.json"),
    "jobs_file": ("KROBI_JOBS_FILE", "jobs.sqlite"),
    "analysis_db": ("KROBI_ANALYSIS_DB", "analysis.sqlite"),
    "tools_dir": ("KROBI_TOOLS_DIR", "tools"),
    "models_dir": ("KROBI_MODELS_DIR", "models"),
    "stems_dir": ("KROBI_STEMS_DIR", "stems"),
}

RETIRED_SETTINGS = (
    "KROBI_ANALYSIS_AUTO_LIBRARY", "KROBI_ANALYSIS_AUTO_UPGRADE",
    "KROBI_NEST_LIBRARY_START_HOUR", "KROBI_NEST_LIBRARY_END_HOUR",
)


_OFF_WORDS = {"false", "0", "no", "off"}


def env_true(name: str, default: str = "false") -> bool:
    """A switch that is on only when the variable reads ``true`` (any case)."""
    return os.getenv(name, default).lower() == "true"


def env_paths(home: Path, table: dict[str, tuple[str, str]]) -> dict[str, Path]:
    """Constructor kwargs for every ``table`` entry: the env var, else ``home/<name>``."""
    return {
        kwarg: Path(os.getenv(var, str(home / name)))
        for kwarg, (var, name) in table.items()
    }


def log_retired_settings(logger):
    for key in RETIRED_SETTINGS:
        if key in os.environ:
            logger.warning("%s is no longer used; ignored", key)


def settings_from_env() -> dict:
    """Capacity, timeouts, logging and the feature switches, as constructor kwargs."""
    download_timeout = os.getenv("KROBI_DOWNLOAD_TIMEOUT", "300")
    return {
        "max_concurrent_downloads": int(os.getenv("KROBI_MAX_CONCURRENT_DOWNLOADS", "2")),
        "max_concurrent_jobs": int(os.getenv("KROBI_MAX_CONCURRENT_JOBS", "2")),
        "analysis_workers": int(os.getenv("KROBI_ANALYSIS_WORKERS", "2")),
        "download_timeout": int(download_timeout),
        # Falls back to the older shared timeout, which still drives source.
        "editor_render_timeout": int(os.getenv("KROBI_EDITOR_RENDER_TIMEOUT", download_timeout)),
        "log_level": os.getenv("KROBI_LOG_LEVEL", "INFO"),
        "enable_waveform_cache": env_true("KROBI_ENABLE_WAVEFORM_CACHE", "true"),
        "cover_cache_mb": int(os.getenv("KROBI_COVER_CACHE_MB", "200")),
        "source_cookies_from_browser": os.getenv("KROBI_YTDLP_COOKIES_FROM_BROWSER") or None,
        "source_cookies_file": os.getenv("KROBI_YTDLP_COOKIES_FILE") or None,
        # Opt-in: write detected BPM/key back into file tags.
        "write_analysis_tags": env_true("KROBI_WRITE_ANALYSIS_TAGS"),
        "analysis_auto": env_true("KROBI_ANALYSIS_AUTO", "true"),
        "lyrics_auto_fetch": env_true("KROBI_LYRICS_AUTO_FETCH"),
        "lyrics_engine_mode": os.getenv("KROBI_LYRICS_ENGINE", "auto").strip().lower() or "auto",
        "nest_processes": env_true("KROBI_NEST_PROCESSES"),
        "nest_cpu_percent": int(os.getenv('KROBI_NEST_CPU_PERCENT', '50')),
        "nest_max_temp_c": int(os.getenv('KROBI_NEST_MAX_TEMP_C', '85')),
        "nest_resume_temp_c": int(os.getenv('KROBI_NEST_RESUME_TEMP_C', '75')),
        "stems_background": env_true("KROBI_STEMS_BACKGROUND"),
        # Release checks and LAN advertisement are on unless explicitly disabled.
        "update_check": os.getenv("KROBI_UPDATE_CHECK", "true").strip().lower() not in _OFF_WORDS,
        "advertise": os.getenv("KROBI_ADVERTISE", "true").strip().lower() not in _OFF_WORDS,
    }


def auth_from_env() -> dict:
    """API keys and who may call this server, as constructor kwargs.

    Read from the environment like everything else, which means
    app/main.py::_load_env() has already merged ~/Krobi/.env — so the token
    persists across restarts and packaged runs exactly the way the Spotify
    credentials do. Strict first-run setup is off by default; see
    app/domains/accounts/claim.py for why the convenient mode is the default
    one and what that costs.
    """
    return {
        "genius_api_key": os.getenv("KROBI_GENIUS_API_KEY"),
        "api_token": os.getenv("KROBI_API_TOKEN"),
        "allow_unauthenticated_remote": env_true("KROBI_ALLOW_UNAUTHENTICATED_REMOTE"),
        "allow_remote_local_actions": env_true("KROBI_ALLOW_REMOTE_LOCAL_ACTIONS"),
        "require_setup_token": env_true("KROBI_REQUIRE_SETUP_TOKEN"),
    }


def spotify_redirect_uri() -> str:
    """The OAuth callback Spotify sends the consent browser back to.

    A loopback IP literal, because Spotify rejects ``localhost``, and it must
    exactly match a Redirect URI registered in the Spotify dashboard. The port
    comes from ``KROBI_BACKEND_PORT`` (exported by ``python -m app`` and the
    packaged binary from their own ``--port``) rather than a hardcoded :8000;
    register the loopback range (127.0.0.1:8000..8005/api/spotify/callback) so
    a backend started on another port still matches.
    """
    backend_port = os.getenv("KROBI_BACKEND_PORT", "8000")
    return os.getenv(
        "SPOTIFY_REDIRECT_URI",
        f"http://127.0.0.1:{backend_port}/api/spotify/callback",
    )


class ConfigManager:
    def __init__(
        self,
        base_music_dir: Path,
        playlist_dir: Path,
        temp_dir: Path,
        log_dir: Path,
        credentials_dir: Path,
        genius_api_key: str | None = None,
        max_concurrent_downloads: int = 2,
        download_timeout: int = 300,
        log_level: str = "INFO",
        enable_waveform_cache: bool = True,
        source_cookies_from_browser: str | None = None,
        source_cookies_file: str | None = None,
        write_analysis_tags: bool = False,
        analysis_auto: bool = True,
        api_token: str | None = None,
        allow_unauthenticated_remote: bool = False,
        allow_remote_local_actions: bool = False,
        require_setup_token: bool = False,
        providers_file: Path | None = None,
        users_file: Path | None = None,
        user_tracks_file: Path | None = None,
        instance_file: Path | None = None,
        update_check_file: Path | None = None,
        setup_token_file: Path | None = None,
        lyrics_file: Path | None = None,
        jobs_file: Path | None = None,
        analysis_db: Path | None = None,
        lyrics_auto_fetch: bool = False,
        tools_dir: Path | None = None,
        models_dir: Path | None = None,
        lyrics_engine_mode: str = "auto",
        nest_processes: bool = False,
        nest_cpu_percent: int = 50,
        nest_max_temp_c: int = 85,
        nest_resume_temp_c: int = 75,
        stems_dir: Path | None = None,
        stems_background: bool = False,
        advertise: bool = True,
        update_check: bool = True,
        max_concurrent_jobs: int = 2,
        analysis_workers: int = 2,
        editor_render_timeout: int = 300,
        cover_cache_mb: int = 200,
    ):
        self.base_music_dir = base_music_dir
        self.playlist_dir = playlist_dir
        self.temp_dir = temp_dir
        self.log_dir = log_dir
        self.credentials_dir = credentials_dir
        self.genius_api_key = genius_api_key
        # Filled by the secrets boundary after state paths are resolved.
        self.spotify_client_id = None
        self.spotify_client_secret = None
        self.spotify_refresh_token = None
        self.spotify_redirect_uri = spotify_redirect_uri()
        self._init_capacity(
            max_concurrent_downloads=max_concurrent_downloads,
            max_concurrent_jobs=max_concurrent_jobs,
            analysis_workers=analysis_workers,
            download_timeout=download_timeout,
            editor_render_timeout=editor_render_timeout,
        )
        self.log_level = log_level
        self.enable_waveform_cache = enable_waveform_cache
        self.analysis_auto = analysis_auto
        self.cover_cache_mb = cover_cache_mb
        # Persistent cache beside the data files, outside the swept temp dir.
        self.cover_cache_dir = playlist_dir.parent / "cache" / "covers"
        self._init_media_switches(
            source_cookies_from_browser=source_cookies_from_browser,
            source_cookies_file=source_cookies_file,
            write_analysis_tags=write_analysis_tags,
        )
        self._init_auth(
            api_token=api_token,
            allow_unauthenticated_remote=allow_unauthenticated_remote,
            allow_remote_local_actions=allow_remote_local_actions,
            require_setup_token=require_setup_token,
        )
        self._init_state_paths(
            playlist_dir.parent,
            providers_file=providers_file,
            users_file=users_file,
            user_tracks_file=user_tracks_file,
            instance_file=instance_file,
            update_check_file=update_check_file,
            setup_token_file=setup_token_file,
            lyrics_file=lyrics_file,
            jobs_file=jobs_file,
            analysis_db=analysis_db,
            tools_dir=tools_dir,
            models_dir=models_dir,
            stems_dir=stems_dir,
        )
        # Resolve and migrate credentials before composing any provider or auth.
        apply_to_config(self)
        # Constructor injection is useful for embedders/tests; process values
        # still win, and an unreadable store must never fall back to a guess.
        if (not self.secrets.unreadable and "KROBI_GENIUS_API_KEY" not in self.secrets.external
                and "KROBI_GENIUS_API_KEY" not in self.secrets.records):
            self.genius_api_key = genius_api_key
        # Opt-in: ask the lyrics catalogs for every song that lacks one — at
        # startup and whenever an acquisition lands, from any client.
        # Runtime-mutable via PUT /api/lyrics/config; persisted to ~/Krobi/.env.
        self.lyrics_auto_fetch = lyrics_auto_fetch
        # auto | local | agent — who runs the lyrics engine. See LyricsService.engine_mode.
        self.lyrics_engine_mode = lyrics_engine_mode
        self.nest_processes = nest_processes
        from app.infra.nest_limits import validate
        validate(nest_cpu_percent, nest_max_temp_c, nest_resume_temp_c)
        self.nest_cpu_percent = nest_cpu_percent
        self.nest_max_temp_c = nest_max_temp_c
        self.nest_resume_temp_c = nest_resume_temp_c
        self.stems_background = stems_background
        # Announce this server on the LAN as _krobi._tcp (app/infra/discovery.py)
        # once it has an owner, so desktops on the same network can list it.
        # KROBI_ADVERTISE=false turns it off; the test suite always does.
        self.advertise = advertise
        self.update_check = update_check
        # Absolute ffmpeg path resolved once; subprocess callers use this instead
        # of a bare "ffmpeg" so packaged builds (no PATH) still find the binary.
        ffmpeg = resolve_ffmpeg_info()
        self.ffmpeg_path = ffmpeg.path
        self.ffmpeg_version = ffmpeg.version
        self.ffmpeg_source = ffmpeg.source

    def _init_capacity(
        self,
        *,
        max_concurrent_downloads: int,
        max_concurrent_jobs: int,
        analysis_workers: int,
        download_timeout: int,
        editor_render_timeout: int,
    ) -> None:
        self.max_concurrent_downloads = max(1, min(4, max_concurrent_downloads))
        self.download_timeout = download_timeout
        self.editor_render_timeout = editor_render_timeout
        self.max_concurrent_jobs = max_concurrent_jobs
        # Existing settings presets still round-trip this value; helpers own analysis capacity.
        self.analysis_workers = analysis_workers
        # The limiters read the attribute on every acquire, so a live change to
        # the setting applies without rebuilding them.
        self.download_limiter = CapacityLimiter(lambda: max(1, min(4, self.max_concurrent_downloads)))
        self.job_limiter = CapacityLimiter(lambda: self.max_concurrent_jobs)

    def _init_media_switches(
        self,
        *,
        source_cookies_from_browser: str | None,
        source_cookies_file: str | None,
        write_analysis_tags: bool,
    ) -> None:
        # Host-managed cookie aliases, mutable through the compatibility route.
        self.source_cookies_from_browser = source_cookies_from_browser or None
        self.source_cookies_file = source_cookies_file or None
        # Retained for existing settings; no analysis tag writing runs in this step.
        self.write_analysis_tags = write_analysis_tags

    def _init_auth(
        self,
        *,
        api_token: str | None,
        allow_unauthenticated_remote: bool,
        allow_remote_local_actions: bool,
        require_setup_token: bool,
    ) -> None:
        # Shared secret every API caller must present once it is set. Defaults to
        # None, which keeps the loopback-only desktop app working untouched — the
        # full policy (and why an empty string must collapse to None) lives in
        # app/domains/accounts/auth.py.
        self.api_token = (api_token or "").strip() or None
        self.allow_unauthenticated_remote = allow_unauthenticated_remote
        self.allow_remote_local_actions = allow_remote_local_actions
        # Whether the one-shot first-run claim (POST /api/claim) must present the
        # setup token this server generated on the boot that found no users.
        # Defaults to False — the low-friction path, because the whole point of
        # the claim is setting up a server you have no shell on; the full
        # reasoning and the threat model are in app/domains/accounts/claim.py, and
        # GET /api/status advertises which mode is in force.
        self.require_setup_token = require_setup_token

    def _init_state_paths(self, home: Path, **given: Path | None) -> None:
        """Resolve state files under the configured data directory.

        Use playlist_dir.parent so relocated libraries and tests stay isolated.
        Store instance identity inside the directory it identifies."""
        def path(kwarg: str) -> Path:
            return given.get(kwarg) or (home / STATE_PATHS[kwarg][1])

        # Where the provider registry persists enable/disable and order.
        self.providers_file = path("providers_file")
        # Per-user API tokens (app/domains/accounts/identity.py).
        self.users_file = path("users_file")
        # Per-user library rows (app/domains/user_library/store.py).
        self.user_tracks_file = path("user_tracks_file")
        # This server's own id and name (app/infra/instance.py).
        self.instance_file = path("instance_file")
        self.update_check_file = path("update_check_file")
        # The first-run setup token (app/domains/accounts/claim.py). Beside
        # users.json because it guards the creation of that file's first row.
        self.setup_token_file = path("setup_token_file")
        # The lyrics index: metadata about the .lrc/.txt sidecars beside the audio.
        self.lyrics_file = path("lyrics_file")
        self.jobs_file = path("jobs_file")
        self.analysis_db = path("analysis_db")
        # Programs the backend installs on demand (the lyrics engine) and the
        # models they download, created lazily by whoever needs them — most
        # installs never do.
        self.tools_dir = path("tools_dir")
        self.models_dir = path("models_dir")
        # Separated stems + song.json per track (domains/stems). Outside the
        # music library on purpose, so a library scan never sees them.
        self.stems_dir = path("stems_dir")

    @classmethod
    def from_env(cls) -> "ConfigManager":
        dirs = env_paths(KROBI_HOME, REQUIRED_DIRS)
        # Read app-owned music choices here too: a new config must not depend
        # on main's one-time dotenv load (or its stale process copy).
        key = "KROBI_MUSIC_DIR"
        saved = env_sources.read_values(dirs["credentials_dir"].parent / ".env").get(key)
        if saved and key not in env_sources.ENV_KEYS and (key not in os.environ or key in env_sources.APP_KEYS):
            dirs["base_music_dir"] = Path(saved).expanduser()
        for directory in dirs.values():
            directory.mkdir(parents=True, exist_ok=True)

        config = cls(
            **dirs,
            **env_paths(KROBI_HOME, STATE_PATHS),
            **settings_from_env(),
            **auth_from_env(),
        )
        config.validate()
        return config

    @property
    def secrets(self) -> SecretStore:
        # Tests and embedders can relocate a ConfigManager without carrying a
        # vault from its previous data directory along with it.
        store = getattr(self, "_secrets", None)
        if store is None or store.directory != self.credentials_dir or store.instance_file != self.instance_file:
            self._secrets = SecretStore(self.credentials_dir, self.instance_file)
        return self._secrets

    def validate(self) -> None:
        if self.cover_cache_mb < 1:
            raise ConfigurationError("cover_cache_mb must be at least 1")
        if not self.base_music_dir.exists():
            raise ConfigurationError(f"Music directory does not exist: {self.base_music_dir}")

        if not self.playlist_dir.exists():
            raise ConfigurationError(f"Playlist directory does not exist: {self.playlist_dir}")

        if not self.temp_dir.exists():
            raise ConfigurationError(f"Temp directory does not exist: {self.temp_dir}")

        if not self.log_dir.exists():
            raise ConfigurationError(f"Log directory does not exist: {self.log_dir}")

        if not self.credentials_dir.exists():
            raise ConfigurationError(f"Credentials directory does not exist: {self.credentials_dir}")
        if self.max_concurrent_downloads < 1:
            raise ConfigurationError("max_concurrent_downloads must be at least 1")

        if not 1 <= self.max_concurrent_jobs <= 8 or self.analysis_workers < 1:
            raise ConfigurationError("Invalid job or analysis capacity")
        if self.editor_render_timeout < 1:
            raise ConfigurationError("editor_render_timeout must be at least 1")
        if self.download_timeout < 1:
            raise ConfigurationError("download_timeout must be at least 1")

        valid_log_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        if self.log_level.upper() not in valid_log_levels:
            raise ConfigurationError(
                f"Invalid log level: {self.log_level}. Must be one of {valid_log_levels}"
            )
