from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar
from collections.abc import Callable
from threading import RLock
import time

from fastapi import Depends, HTTPException, Request, Response

from app.infra.request_paths import routing_path
from app.config import ConfigManager
from app.domains.accounts.recheck import authorize_key_export as authorize_key_export
from app.infra.identity import get_config as get_config, get_token_resolver, current_principal, is_real_user
from app.infra.logging import LoggerConfig
from app.infra.changes import Changes
from app.infra.change_bus import ChangeBus
from app.infra.etags import ConditionalContext, conditional as area_conditional
from app.infra.identity import Principal

if TYPE_CHECKING:
    from app.domains.browse.services import BrowseService
    from app.domains.dashboard.services import DashboardService
    from app.domains.downloads.services import DownloadService
    from app.domains.lyrics.services import LyricsService
    from app.domains.metadata.services import MetadataService
    from app.domains.music.analysis_repository import AnalysisRepository
    from app.domains.music.covers import CoverCache
    from app.domains.music.services import MusicService
    from app.domains.playlists.services import PlaylistService
    from app.domains.transfers.services import TransferService
    from app.infra.discovery import NestAdvertiser
    from app.infra.progress import ProgressTracker
    from app.domains.accounts.identity import TokenStore
    from app.domains.accounts.sign_in_code import SignInCodes
    from app.domains.user_library.scope import LibraryScope
    from app.domains.user_library.store import UserTrackStore
    from app.providers.registry import ProviderRegistry
    from app.domains.metadata.genres import AlbumGenres
    from app.domains.metadata.resolution_service import ResolutionService
    from app.domains.playlists.export_import import ExportImportService
    from app.domains.subsonic.app_passwords import AppPasswordVault
    from app.domains.subsonic.stars import StarStore


# Compatibility dependency alias: overrides keep the same FastAPI callable.
get_token_store = get_token_resolver

T = TypeVar("T")


class DependencyContainer:
    def __init__(self, config: ConfigManager) -> None:
        self.config = config
        self.started_at = time.time()
        self._services: dict[str, Any] = {}
        self._singleton_lock = RLock()
        self._repositories: dict[str, Any] = {}
        self._logger = LoggerConfig.get_logger(__name__)
        self.changes = Changes({
            'library': self._library_revision,
            'analysis': lambda: self.get_analysis_repository().revision,
            'jobs': self._jobs_revision,
            'lyrics': self._lyrics_revision,
            'helpers': self._helpers_revision,
            'signin': lambda: (self.changes.counter('signin'), self.get_sign_in_codes().expiry_revision()),
            'config': self._config_revision,
        }, wired=('library', 'analysis', 'jobs', 'lyrics', 'playlists', 'config', 'helpers', 'signin', 'me:<account>'))

        self.change_bus = ChangeBus(self.changes)

    def _library_revision(self):
        return self.changes.counter('library')

    def _jobs_revision(self):
        return (self.changes.counter('jobs'), self.get_jobs().version, self.config.download_limiter.active, self.config.job_limiter.active,
                self.get_lyrics_service().agent_queue.degraded,
                getattr(self.get_stems_service().repository, 'queue_degraded', False))

    def _lyrics_revision(self):
        service = self.get_lyrics_service()
        with service._queue_lock:
            live = tuple(job.rel_path for job in service._queue)
            current = service._current
            active = current.rel_path if current and current.batch.progress_id in service._batches else None
        return self.changes.counter('lyrics'), live, active

    def _helpers_revision(self):
        worker = self.get_lyrics_service().agent_queue.worker
        nest = self.get_nest_helper()
        ledger = self.get_jobs()
        with ledger.lock:
            scheduled = ledger.db.execute("SELECT 1 FROM worker_limits WHERE json_extract(data, '$.window') IS NOT NULL LIMIT 1").fetchone()
        return (self.changes.counter('helpers'), worker.expiry_revision(), nest.revision_inputs(),
                int(time.time() // 60) if scheduled else None)

    def _config_revision(self):
        from app.domains.server.services import ServerConfigService
        service = self.singleton('server_config', lambda: ServerConfigService(self))
        return self.changes.counter('config'), service.revision_inputs()

    def maintain_jobs(self):
        self.get_lyrics_service().agent_queue.worker.maintain()
        self.get_jobs().flush_phases()
        self.get_jobs().retention()
        self.get_source_installer().maintain()
        self.refresh_source_status()

    def singleton(self, key: str, factory: Callable[[], T]) -> T:
        """Build a service once, including concurrent first requests.

        Every getter goes through here (or ``_repository``): sync routes run on
        the threadpool, so an unlocked check-then-set lets two first requests
        each build their own instance — two lyrics workers, two Deezer rate
        limiters. The lock is reentrant because factories call other getters.
        """
        with self._singleton_lock:
            if key not in self._services:
                self._services[key] = factory()
            return self._services[key]

    def _repository(self, key: str, factory: Callable[[], T]) -> T:
        """``singleton`` for the repository table, under the same lock."""
        with self._singleton_lock:
            if key not in self._repositories:
                self._repositories[key] = factory()
            return self._repositories[key]

    def get_cover_cache(self) -> CoverCache:
        from app.domains.music.covers import CoverCache
        return self.singleton("cover_cache", lambda: CoverCache(
            self.config.cover_cache_dir, self.config.cover_cache_mb * 1024 * 1024,
        ))

    def get_music_service(self) -> MusicService:
        def _build():
            from app.domains.music.services import MusicService
            service = MusicService(
                music_repo=self.get_music_repository(),
                metadata_repo=self.get_metadata_repository(),
                config=self.config,
                logger=LoggerConfig.get_logger("app.domains.music.services"),
            )
            service.deletion_listeners.append(self._forget_lyric)
            service.deletion_listeners.append(self._forget_stems)
            return service
        return self.singleton("music_service", _build)

    def _forget_lyric(self, audio_path) -> None:
        """A deleted song takes its lyric with it. Looked up per call, not bound
        once: the lyrics service is built at startup but may be rebuilt (tests
        do, per test), and a bound method would keep writing to a stale index."""
        self.get_lyrics_service().forget_file(audio_path)

    def _forget_stems(self, audio_path) -> None:
        from app.utils.library_paths import rel_path_for, split_rel_path
        rel = rel_path_for(self.config.base_music_dir, audio_path)
        if rel is not None:
            self.get_stems_service().delete(*split_rel_path(rel))

    def get_playlist_service(self) -> PlaylistService:
        # Not ``singleton()``: the service must be cached *before* the migration
        # below runs (see there), which a factory cannot express. Same lock.
        with self._singleton_lock:
            return self._get_playlist_service_locked()

    def _get_playlist_service_locked(self) -> PlaylistService:
        if "playlist_service" not in self._services:
            from app.domains.playlists.services import PlaylistService
            playlist_repo = self.get_playlist_repository()
            music_repo = self.get_music_repository()
            logger = LoggerConfig.get_logger("app.domains.playlists.services")
            self._services["playlist_service"] = PlaylistService(
                playlist_repo=playlist_repo,
                music_repo=music_repo,
                config=self.config,
                logger=logger,
            )
            # Give pre-ownership playlists an owner, once per library. Run here,
            # on first use of the domain, rather than at import time in main.py:
            # importing app.main is something the test suite does against the
            # developer's real ~/Krobi, and a migration that fires on import
            # would rewrite the playlists of the app they are actually using.
            # The marker inside makes this a no-op on every later start.
            #
            # Cached above first, so a re-entrant call during the migration
            # cannot start a second one.
            from app.domains.playlists.ownership import migrate_playlist_ownership
            try:
                migrate_playlist_ownership(
                    self.config, playlist_repo, self.get_token_store(), logger
                )
            except Exception as e:
                # Failed ownership migration must leave playlists accessible to owners.
                logger.warning("Playlist ownership migration failed: %s", e)
        return self._services["playlist_service"]

    def get_download_service(self) -> DownloadService:
        def _build():
            from app.domains.downloads.services import DownloadService
            service = DownloadService(
                download_repo=self.get_download_repository(),
                metadata_repo=self.get_metadata_repository(),
                progress_tracker=self.get_progress_tracker(),
                config=self.config,
                logger=LoggerConfig.get_logger("app.domains.downloads.services"),
                spotify_auth=self.get_spotify_auth(),
                ownership=self.get_ownership_index(),
            )
            service.engine.acquisition = self._acquisition_for(service.engine)
            return service
        service = self.singleton("download_service", _build)
        # A composed service follows relocated roots and ledgers. Explicitly
        # supplied standalone services keep their caller's execution policy.
        if service.engine.acquisition is not None:
            self._acquisition_for(service.engine)
        return service

    def get_source_health(self):
        from app.domains.acquisition.health import SourceHealth
        ledger = self.get_jobs()
        with self._singleton_lock:
            health = self._services.get('source-health')
            if health is None or health.ledger is not ledger:
                health = SourceHealth(ledger, started_at=self.started_at, on_failure=lambda *args: None)
                self._services['source-health'] = health
            return health

    def get_acquisition(self):
        return self._acquisition_for(self.get_download_service().engine)

    def _acquisition_for(self, engine):
        from app.domains.acquisition.services import Pipeline
        from app.providers.registry import ProviderKind
        ledger = self.get_jobs()
        with self._singleton_lock:
            service = self._services.get('acquisition')
            if (service is None or service.ledger is not ledger or service.engine is not engine
                    or service.root != self.config.base_music_dir):
                service = Pipeline(ledger=ledger, engine=engine, ownership=self.get_ownership_index(),
                    user_tracks=self.get_user_track_store(), root=self.config.base_music_dir,
                    data=self.config.jobs_file.parent, tracker=self.get_progress_tracker(),
                    metadata_lookup=lambda: self.get_album_genres(self.get_provider_registry()),
                    relocator=self.get_track_relocator, music=self.get_music_repository(),
                    health=self.get_source_health(),
                    sources=lambda: self.get_provider_registry().order(ProviderKind.STREAMING))
                self._services['acquisition'] = service
            engine.acquisition = service
            return service

    def get_uploads(self):
        from app.domains.acquisition.uploads import Uploads
        pipeline = self.get_acquisition()
        with self._singleton_lock:
            service = self._services.get('uploads')
            if service is None or service.pipeline is not pipeline:
                service = Uploads(pipeline)
                self._services['uploads'] = service
            return service

    def get_metadata_service(self) -> MetadataService:
        def _build():
            from app.domains.metadata.services import MetadataService
            metadata_repo = self.get_metadata_repository()
            genius_repo = self.get_genius_repository()
            logger = LoggerConfig.get_logger("app.domains.metadata.services")
            return MetadataService(
                metadata_repo=metadata_repo,
                genius_repo=genius_repo,
                config=self.config,
                logger=logger,
            )
        return self.singleton("metadata_service", _build)

    def get_transfer_service(self) -> TransferService:
        def _build():
            from app.domains.transfers.services import TransferService
            transfer_repo = self.get_transfer_repository()
            logger = LoggerConfig.get_logger("app.domains.transfers.services")
            return TransferService(
                transfer_repo=transfer_repo,
                config=self.config,
                logger=logger,
            )
        return self.singleton("transfer_service", _build)


    def get_dashboard_service(self) -> DashboardService:
        def _build():
            from app.domains.dashboard.repositories import DeezerDashboardProvider
            from app.domains.dashboard.services import DashboardService
            from app.domains.dashboard.your_artists import YourArtistsSource
            logger = LoggerConfig.get_logger("app.domains.dashboard.services")
            provider = DeezerDashboardProvider(
                # The one shared DeezerRepository, so the dashboard's requests
                # go through the same rate limiter and quota backoff as every
                # other Deezer call in the process. A second client would be a
                # second unthrottled path to the same per-IP quota.
                deezer=self.get_deezer_repository(),
                logger=LoggerConfig.get_logger("app.domains.dashboard.repositories"),
            )
            return DashboardService(
                provider=provider,
                cache_repo=self.get_dashboard_cache_repository(),
                config=self.config,
                logger=logger,
                # So disabling the Deezer dashboard in Settings -> Sources
                # actually stops the outbound requests, rather than only
                # hiding the row.
                registry=self.get_provider_registry(),
                # "More from your artists": the library's artists, looked up through
                # the same shared DeezerRepository.
                your_artists=YourArtistsSource(
                    deezer=self.get_deezer_repository(),
                    music_repository=self.get_music_repository(),
                    logger=LoggerConfig.get_logger("app.domains.dashboard.your_artists"),
                ),
            )
        return self.singleton("dashboard_service", _build)

    def get_ownership_index(self):
        def _build():
            from app.domains.music.ownership import OwnershipIndex
            logger = LoggerConfig.get_logger("app.domains.music.ownership")
            return OwnershipIndex(
                music_repository=self.get_music_repository(),
                config=self.config,
                logger=logger,
            )
        return self.singleton("ownership_index", _build)

    def get_track_relocator(self):
        """Moves and replaces songs, keeping every path-keyed store pointing at
        them (``domains/music/relocation.py``). Built per call, never cached:
        it carries the music root, which ``/api/set-basedir`` can change."""
        from app.domains.music.relocation import TrackRelocator
        return TrackRelocator(
            base_music_dir=self.config.base_music_dir,
            music_service=self.get_music_service(),
            user_tracks=self.get_user_track_store(),
            jobs_file=self.config.jobs_file,
            playlist_repository=self.get_playlist_repository(),
            lyrics_service=lambda: self._services.get("lyrics_service"),
            stems_repository=lambda: getattr(self._services.get("stems_service"), "repository", None),
            logger_=LoggerConfig.get_logger("app.domains.music.relocation"),
        )

    def get_browse_service(self) -> BrowseService:
        def _build():
            from app.domains.browse.services import BrowseService
            logger = LoggerConfig.get_logger("app.domains.browse.services")
            return BrowseService(
                # Browse dispatches *through* the registry rather than around
                # it: the first enabled METADATA provider declaring the needed
                # capability serves the page, so the order in Settings -> Sources
                # is what actually decides. (The dashboard is the deliberate
                # exception -- it caches its own rows, so routing it through the
                # registry would open a second uncached path to Deezer.)
                registry=self.get_provider_registry(),
                cache_repo=self.get_browse_cache_repository(),
                config=self.config,
                logger=logger,
            )
        return self.singleton("browse_service", _build)

    def get_browse_cache_repository(self):
        def _build():
            from app.domains.browse.repositories import BrowseCacheRepository
            logger = LoggerConfig.get_logger("app.domains.browse.repositories")
            return BrowseCacheRepository(
                config=self.config, logger=logger
            )
        return self._repository("browse_cache_repository", _build)

    def get_dashboard_cache_repository(self):
        def _build():
            from app.domains.dashboard.repositories import DashboardCacheRepository
            logger = LoggerConfig.get_logger("app.domains.dashboard.repositories")
            return DashboardCacheRepository(
                config=self.config, logger=logger
            )
        return self._repository("dashboard_cache_repository", _build)

    def get_deezer_repository(self):
        def _build():
            from app.domains.metadata.deezer_repository import DeezerRepository
            logger = LoggerConfig.get_logger("app.domains.metadata.deezer_repository")
            return DeezerRepository(config=self.config, logger=logger)
        return self._repository("deezer_repository", _build)


    def get_music_repository(self):
        def _build():
            from app.domains.music.repositories import MusicRepository
            logger = LoggerConfig.get_logger("app.domains.music.repositories")
            return MusicRepository(
                config=self.config, logger=logger, analysis=self.get_analysis_repository(), changes=self.changes
            )
        return self._repository("music_repository", _build)

    def get_tag_edits(self):
        def _build():
            from app.domains.music.tag_edits import TagEdits
            return TagEdits(self.config, self.get_analysis_repository(), self.get_music_repository(), self.get_progress_tracker())
        return self.singleton('tag_edits', _build)

    def get_duplicate_service(self):
        from app.domains.music.duplicate_service import DuplicateService
        return self.singleton('duplicate_service', lambda: DuplicateService(
            self.config, self.get_music_repository(), self.get_analysis_repository(),
            self.get_progress_tracker(), self.get_user_track_store()))
    def get_library_keys(self):
        def build():
            from app.domains.music.library_keys import LibraryKeys
            from app.domains.music.missing_references import LyricReferences, PlayReferences, StemReferences
            from app.domains.playlists.missing_references import PlaylistReferences
            keys = LibraryKeys()
            keys.register('accounts', self.get_user_track_store())
            keys.register('analysis', self.get_analysis_repository())
            keys.register('playlists', PlaylistReferences(self.get_playlist_repository(), self.config))
            keys.register('plays', PlayReferences(self.config.jobs_file))
            keys.register('lyrics', LyricReferences(self.get_lyrics_service().repository))
            keys.register('stems', StemReferences(self.get_stems_service().repository))
            return keys
        return self.singleton('library_keys', build)

    def get_missing_files(self):
        def build():
            from app.domains.music.missing_files import MissingFiles
            keys = self.get_library_keys()
            service = MissingFiles(self.config, self.get_music_repository(), self.get_tag_edits(), keys,
                self.get_user_track_store(), keys.participants['playlists'], keys.participants['plays'],
                self.get_track_relocator,
                lambda: {u.user_id: u.label for u in self.get_token_store().list_users()})
            self.get_tag_edits().missing_files = service
            return service
        return self.singleton('missing_files', build)

    def get_library_health(self):
        def build():
            from app.domains.music.library_health import LibraryHealth
            service = LibraryHealth(self.get_music_repository(), self.get_missing_files, self.get_backups())
            self.get_music_repository().scans.health_publisher = service.publish
            return service
        return self.singleton('library_health', build)

    def get_match_service(self):
        from app.domains.music.match_service import MatchService
        return self.singleton('match_service', lambda: MatchService(
            self.config, self.get_tag_edits(), self.get_musicbrainz_repository(), self.get_progress_tracker()))

    def get_analysis_repository(self) -> AnalysisRepository:
        """One music-owned analysis store shared with the startup migration."""
        def _build():
            from app.domains.music.analysis_repository import AnalysisRepository
            return AnalysisRepository(self.config.analysis_db, changes=self.changes)
        return self.singleton("analysis_repository", _build)

    def get_playlist_repository(self):
        def _build():
            from app.domains.playlists.repositories import PlaylistRepository
            logger = LoggerConfig.get_logger("app.domains.playlists.repositories")
            return PlaylistRepository(config=self.config, logger=logger, changes=self.changes)
        return self._repository("playlist_repository", _build)

    def get_download_repository(self):
        def _build():
            from app.domains.downloads.repositories import DownloadRepository
            logger = LoggerConfig.get_logger("app.domains.downloads.repositories")
            return DownloadRepository(config=self.config, logger=logger, source=self._selected_source)
        return self._repository("download_repository", _build)

    def get_metadata_repository(self):
        def _build():
            from app.domains.metadata.repositories import MetadataRepository
            logger = LoggerConfig.get_logger("app.domains.metadata.repositories")
            return MetadataRepository(config=self.config, logger=logger, tag_writer=self.get_tag_edits().edit)
        return self._repository("metadata_repository", _build)

    def get_genius_repository(self):
        def _build():
            from app.domains.metadata.repositories import GeniusRepository
            logger = LoggerConfig.get_logger("app.domains.metadata.repositories")
            return GeniusRepository(config=self.config, logger=logger)
        return self._repository("genius_repository", _build)

    def get_transfer_repository(self):
        def _build():
            from app.domains.transfers.repositories import TransferRepository
            logger = LoggerConfig.get_logger("app.domains.transfers.repositories")
            return TransferRepository(config=self.config, logger=logger)
        return self._repository("transfer_repository", _build)


    def get_spotify_auth(self):
        def _build():
            from app.domains.metadata.spotify_auth import SpotifyAuth
            logger = LoggerConfig.get_logger("app.domains.metadata.spotify_auth")
            return SpotifyAuth(config=self.config, logger=logger)
        return self.singleton("spotify_auth", _build)

    def get_credentials_repository(self):
        def _build():
            from app.infra.security import CredentialsRepository
            logger = LoggerConfig.get_logger("app.infra.security")
            return CredentialsRepository(config=self.config, logger=logger)
        return self._repository("credentials_repository", _build)

    def _selected_source(self, url=None):
        from app.domains.acquisition.models import AcquisitionError
        from app.providers.registry import ProviderKind
        registry = self.get_provider_registry()
        ids = registry.order(ProviderKind.STREAMING)
        if not ids:
            raise AcquisitionError('no-sources', 409)
        if url is not None:
            from urllib.parse import urlsplit
            host = (urlsplit(url).hostname or '').lower().rstrip('.')
            for id in ids:
                source = registry.instance(id).source
                if host in source.url_hosts:
                    return source
            raise AcquisitionError('no-sources', 409)
        return registry.instance(ids[0]).source

    def stop_sources(self):
        registry = self._services.get('provider_registry')
        if registry is not None:
            from app.providers.registry import ProviderKind
            for descriptor in registry.list(ProviderKind.STREAMING):
                source = getattr(registry.instance(descriptor.id), 'source', None)
                if source is not None:
                    source.close()

    def get_provider_registry(self) -> ProviderRegistry:
        """The one registry for this process.

        Shared rather than per-consumer on purpose: the settings routes and
        ``ResolutionService`` must see the same object, or turning a provider
        off in the UI would leave imports still calling it. Built lazily like
        everything else here, so importing the container does not drag in every
        provider repository.
        """
        def _build():
            from app.providers.adapters import build_default_registry
            logger = LoggerConfig.get_logger("app.providers")
            return build_default_registry(
                self.config, logger, deezer_repo=self.get_deezer_repository()
            )
        registry = self.singleton("provider_registry", _build)
        from app.infra.urls import set_source_hosts
        from app.providers.registry import ProviderKind
        def hosts():
            return {host for id in registry.order(ProviderKind.STREAMING)
                    for host in registry.instance(id).source.url_hosts}
        set_source_hosts(hosts)
        return registry

    def get_token_store(self) -> TokenStore:
        """The per-user token table for this process.

        Rebuilt if ``config.users_file`` moved since the last call. Repositories
        here cache their paths at init, which is exactly the trap to avoid — and for this one it would mean a test (or a relocated ~/Krobi)
        silently authenticating against the developer's real token file.
        """
        from app.domains.accounts.identity import TokenStore
        with self._singleton_lock:
            store = self._services.get("token_store")
            path = self.config.users_file
            if store is None or store.path != path or store.instance_path != self.config.instance_file:
                store = TokenStore(path, LoggerConfig.get_logger("app.domains.accounts.identity"),
                                   instance_path=self.config.instance_file)
                self._services["token_store"] = store
            return store

    def get_sign_in_codes(self) -> SignInCodes:
        from app.domains.accounts.sign_in_code import SignInCodes
        with self._singleton_lock:
            store = self.get_token_store()
            service = self._services.get("sign_in_codes")
            if service is None or service.store is not store:
                service = SignInCodes(store, changes=self.changes)
                self._services["sign_in_codes"] = service
            return service

    def get_user_track_store(self) -> UserTrackStore:
        """Rebuild the personal-library store when its configured path changes.

        A cached old path could write references into another data directory."""
        from app.domains.user_library.store import UserTrackStore
        with self._singleton_lock:
            store = self._services.get("user_track_store")
            path = self.config.user_tracks_file
            if store is None or store.path != path:
                store = UserTrackStore(path, LoggerConfig.get_logger("app.domains.user_library.store"), changes=self.changes)
                self._services["user_track_store"] = store
            return store

    def get_app_password_vault(self) -> AppPasswordVault:
        """The Subsonic app passwords (``domains/subsonic/app_passwords.py``).

        One per credentials repository: the vault caches the decrypted table, so
        two of them over one file would each serve a stale copy of the other's
        writes. Rebuilt when the repository is replaced (tests do).
        """
        from app.domains.subsonic.app_passwords import AppPasswordVault
        with self._singleton_lock:
            credentials = self.get_credentials_repository()
            vault = self._services.get("app_password_vault")
            if vault is None or not vault.uses(credentials):
                vault = AppPasswordVault(credentials)
                self._services["app_password_vault"] = vault
            return vault

    def get_star_store(self) -> StarStore:
        """Subsonic album/artist stars, in ``subsonic-stars.json`` beside
        ``users.json``. Rebuilt if ``config.users_file`` moved, like
        ``get_token_store``."""
        from app.domains.subsonic.stars import StarStore, stars_file_for
        with self._singleton_lock:
            path = stars_file_for(self.config.users_file)
            store = self._services.get("star_store")
            if store is None or store.path != path:
                store = StarStore(path)
                self._services["star_store"] = store
            return store

    def get_album_genres(self, registry: ProviderRegistry) -> AlbumGenres | None:
        """The album → genre cache acquisitions tag with, or None while Deezer
        is off. Rebuilt when the Deezer repository behind ``registry`` changes.

        ``registry`` is passed in rather than read from here so a route that
        was handed a substitute registry (tests) asks that one.
        """
        from app.domains.metadata.genres import AlbumGenres
        from app.providers.registry import ProviderKind
        try:
            if "deezer" not in registry.order(ProviderKind.METADATA):
                return None
            repository = getattr(registry.instance("deezer"), "repository", None)
        except Exception:  # noqa: BLE001 — a genre is an enrichment, never a failure
            return None
        if repository is None:
            return None
        with self._singleton_lock:
            genres = self._services.get("album_genres")
            if genres is None or genres.deezer is not repository:
                genres = AlbumGenres(repository, LoggerConfig.get_logger("app.domains.metadata.genres"))
                self._services["album_genres"] = genres
            return genres

    def get_resolution_service(self) -> ResolutionService:
        """Share resolution caches and provider pacing across imports.

        The shared registry makes provider changes in Settings effective immediately.
        Failed construction is not cached; the route maps it to 503.
        """
        def _build():
            from app.domains.metadata.resolution_service import ResolutionService
            return ResolutionService(
                config=self.config,
                logger=LoggerConfig.get_logger("app.domains.metadata.resolution_service"),
                registry=self.get_provider_registry(),
            )
        return self.singleton("resolution_service", _build)

    def get_export_import_service(self) -> ExportImportService:
        """The Spotify data-export flow's job table (``playlists/export_import.py``).

        One per process: a resolution is read back by id from a later request,
        so the table must outlive any one of them.
        """
        def _build():
            from app.domains.playlists.export_import import ExportImportService
            return ExportImportService(
                logger=LoggerConfig.get_logger("app.domains.playlists.export_import"),
                metadata_lookup=lambda: self.get_album_genres(self.get_provider_registry()),
            )
        return self.singleton("export_import_service", _build)

    def get_lyrics_service(self) -> LyricsService:
        """Share one lyrics queue and batch table across the process.

        Wire acquisition listeners here to avoid a downloads-to-lyrics domain cycle."""
        # Not ``singleton()``: cached before the listener wiring below, like the
        # playlist service. Same lock.
        with self._singleton_lock:
            return self._get_lyrics_service_locked()

    def _get_lyrics_service_locked(self) -> LyricsService:
        if "lyrics_service" not in self._services:
            from app.domains.lyrics.repositories import LyricsRepository
            from app.domains.lyrics.services import LyricsService
            logger = LoggerConfig.get_logger("app.domains.lyrics")
            service = LyricsService(
                repository=LyricsRepository(self.config, logger, changes=self.changes),
                changes=self.changes,
                music_repository=self.get_music_repository(),
                registry=self.get_provider_registry(),
                progress_tracker=self.get_progress_tracker(),
                config=self.config,
                logger=logger,
            )
            self._services["lyrics_service"] = service
            from app.domains.helpers.compute import Compute
            self._services['compute'] = Compute(service.agent_queue.queue, service.agent_queue.worker, self.config, changes=self.changes)
            self.get_download_service().engine.completion_listeners.append(service.enqueue_files)

            def stems_vocals(rel_path: str):
                album, _, file_name = rel_path.partition("/")
                return self.get_stems_service().fresh_vocals(album, file_name)

            service.vocals_lookup = stems_vocals
        return self._services["lyrics_service"]

    def get_analysis_service(self):
        with self._singleton_lock:
            if 'analysis_service' not in self._services:
                from app.domains.music.analysis_jobs import AnalysisService
                service = AnalysisService(self.config, self.get_analysis_repository(), self.get_music_repository(),
                                          self.get_jobs(), self.get_lyrics_service().agent_queue.worker)
                self._services['analysis_service'] = service
                listeners = self.get_download_service().engine.completion_listeners
                if self._enqueue_analysis_files not in listeners:
                    listeners.append(self._enqueue_analysis_files)
                self.get_music_repository().analysis_state = self._analysis_state
                self.get_music_repository().analysis_states = self._analysis_states
            return self._services['analysis_service']

    def _enqueue_analysis_files(self, paths, *, origin=None, batch_total=None):
        bulk_upload = origin == 'upload' and (batch_total if batch_total is not None else len(paths)) > 25
        return self.get_analysis_service().enqueue_files(
            # A big upload yields priority to fresh downloads (library lane) but any server may take it as it
            # lands: the nest's generic guards (CPU cap, memory, thermal pause, placement) protect the host.
            paths, lane='library' if bulk_upload else 'new', nest=True,
            refresh=origin is None)  # Acquisition refreshes once after all listeners.

    def _analysis_states(self):
        service = self._services.get('analysis_service')
        if not service:
            return {}
        return {row['relPath']: 'queued' if row['status'] in ('queued', 'leased') else 'failed'
                for row in service.queue.rows(('analysis',)) if row['status'] in ('queued', 'leased', 'failed')}

    def _analysis_state(self, rel, path, row):
        service = self._services.get('analysis_service')
        return service.state(rel, path, row) if service else (
            'analyzed' if row and row.get('analyzed_at') else 'none')

    def get_compute(self):
        self.get_lyrics_service()
        return self._services['compute']

    def get_nest_helper(self):
        def _build():
            from app.domains.helpers.nest_helper import NestHelper
            return NestHelper(self.config, self.get_lyrics_service, self.get_stems_service, analysis=self.get_analysis_service)
        return self.singleton("nest_helper", _build)

    def get_stems_service(self):
        """The one stems queue for this process.

        Placement follows the lyrics engine (same ``krobi-helper`` program): the
        stems service borrows its binary/env and its ``engine_mode``, and counts
        the lyrics agent as online too — it is the same Mac process, which does
        not claim stems while it is busy on a song.
        """
        def _build():
            from app.domains.stems.repositories import StemsRepository
            from app.domains.stems.services import StemsService
            logger = LoggerConfig.get_logger("app.domains.stems")
            lyrics = self.get_lyrics_service()
            return StemsService(
                repository=StemsRepository(self.config, logger),
                config=self.config,
                logger=logger,
                engine=lyrics.engine,
                engine_mode=lambda: lyrics.engine_mode,
                worker=lyrics.agent_queue.worker,
                ledger=self.get_jobs(),
                progress_tracker=self.get_progress_tracker(),
                read_tags=self.get_music_repository().read_tags,
            )
        return self.singleton("stems_service", _build)

    def get_musicbrainz_repository(self):
        """The registry's own ``MusicBrainzRepository``, not a second one.

        Its rate limiter is per instance and MusicBrainz answers a breach of
        1 req/s with a 503 for *everything*, so a second client (an enrichment
        worker) pacing itself independently of the resolver would get both
        declined. ``build_default_registry`` builds the only instance; this hands
        out that one. Falls back to a private instance only if the registry has
        no MusicBrainz entry (a test registry), where there is nothing to share.
        """
        def _build():
            repo = None
            try:
                repo = getattr(self.get_provider_registry().instance("musicbrainz"), "repository", None)
            except Exception as e:  # UnknownProviderError, or a registry that failed to build
                self._logger.debug("musicbrainz repository not in registry: %s", e)
            if repo is None:
                from app.domains.metadata.musicbrainz_repository import MusicBrainzRepository
                repo = MusicBrainzRepository(
                    self.config, LoggerConfig.get_logger("app.domains.metadata.musicbrainz_repository")
                )
            return repo
        return self._repository("musicbrainz_repository", _build)

    def get_backups(self):
        from app.infra.backups import BackupManager
        return self.singleton("backups", lambda: BackupManager(self.config))

    def get_source_status(self):
        from app.domains.acquisition.sources.status import StatusCache
        return self.singleton('source-status', lambda: StatusCache(self._retry_source_broken, ledger=self.get_jobs()))

    def refresh_source_status(self):
        from app.providers.registry import ProviderKind
        now = time.time()
        if now - getattr(self, '_source_status_at', 0) < 3600:
            return
        self._source_status_at = now
        registry = self.get_provider_registry()
        for id in registry.order(ProviderKind.STREAMING, include_unavailable=True):
            try:
                self.get_source_status().refresh(registry.instance(id).source, force=True)
            except Exception:
                LoggerConfig.get_logger(__name__).warning('Source %s status failed', id)

    def _retry_source_broken(self, source_id, since, until, revision):
        pipeline = self.get_acquisition()
        ids, complete = pipeline.retry_broken(since, until, f'{source_id}:{revision}', source_id=source_id)
        loop = getattr(self, 'event_loop', None)
        if ids and loop is not None and not loop.is_closed():
            for id in ids:
                loop.call_soon_threadsafe(pipeline.kick, id)
        return complete

    def get_source_installer(self):
        from app.domains.acquisition.sources.installer import SourceInstaller
        return self.singleton('source-installer', lambda: SourceInstaller(self))

    def get_update_checker(self):
        from app.infra.updates import UpdateChecker
        return self.singleton("update_checker", lambda: UpdateChecker(self.config))

    def get_nest_advertiser(self) -> NestAdvertiser:
        """The one LAN advertiser for this process (``app/infra/discovery.py``).

        Built once: it owns the mDNS responder. ``is_claimed`` reads the token
        store through this container on every refresh, so a moved
        ``users_file`` is followed rather than cached. A test replaces it by
        assigning ``_services["nest_advertiser"]``.
        """
        def _build():
            from app.config import APP_VERSION
            from app.infra.discovery import NestAdvertiser
            return NestAdvertiser(
                self.config,
                is_claimed=lambda: self.get_token_store().has_users(),
                version=APP_VERSION,
            )
        return self.singleton("nest_advertiser", _build)

    def get_jobs(self):
        from app.infra.jobs import Jobs
        return self.singleton("jobs", lambda: Jobs(self.config.jobs_file, on_change=lambda: self.changes.bump('jobs')))

    def get_progress_tracker(self) -> ProgressTracker:
        def _build():
            from app.infra.progress import ProgressTracker
            return ProgressTracker(self.get_jobs())
        return self.singleton("progress_tracker", _build)


def get_container(request: Request) -> DependencyContainer:
    return request.app.state.container


def get_conditional_context(request: Request, response: Response,
                            container=Depends(get_container), principal: Principal = Depends(current_principal)):
    return ConditionalContext(request, response, container.changes, principal)


def conditional(areas, *, account_scope=False):
    return area_conditional(areas, context=get_conditional_context, account_scope=account_scope)


def get_music_service(request: Request) -> MusicService:
    return request.app.state.container.get_music_service()


def get_cover_cache(request: Request) -> CoverCache:
    return request.app.state.container.get_cover_cache()


def get_playlist_service(request: Request) -> PlaylistService:
    return request.app.state.container.get_playlist_service()


def get_download_service(request: Request) -> DownloadService:
    # This dependency serves previews too: only the acquisition aliases require
    # a person. Check before service dispatch so legacy exception handlers cannot
    # turn a sign-in refusal into a download failure or a background job.
    acquisition_paths = {
        '/api/browse/acquire', '/api/download-album-song', '/api/download-single-song',
        '/api/download-youtube-url', '/api/download-search', '/api/download-spotify-playlist',
        '/api/import-playlist-url', '/api/downloads/retry', '/api/download',
        '/api/playlists/spotify-export/import',
    }
    acquiring = request.method == 'POST' and (routing_path(request) in acquisition_paths
                                            or routing_path(request).startswith('/api/refresh-playlist/'))
    if acquiring and not is_real_user(current_principal(request)):
        raise HTTPException(409, detail={'reason': 'sign-in-required'})
    service = request.app.state.container.get_download_service()
    if acquiring and service.engine.acquisition is not None:
        from app.domains.acquisition.models import AcquisitionError
        try:
            # Refuse before legacy handlers register progress or return a 200
            # for a background job. The pipeline repeats this at admission.
            service.engine.acquisition.check_space()
        except AcquisitionError as error:
            raise HTTPException(error.status, detail={'reason': error.reason})
    return service


def get_metadata_service(request: Request) -> MetadataService:
    return request.app.state.container.get_metadata_service()


def get_transfer_service(request: Request) -> TransferService:
    return request.app.state.container.get_transfer_service()


def get_dashboard_service(request: Request) -> DashboardService:
    return request.app.state.container.get_dashboard_service()


def get_spotify_auth(request: Request):
    return request.app.state.container.get_spotify_auth()


def get_lyrics_service(request: Request) -> LyricsService:
    return get_container(request).get_lyrics_service()


def get_stems_service(request: Request):
    return get_container(request).get_stems_service()


def get_progress_tracker(request: Request) -> ProgressTracker:
    return request.app.state.container.get_progress_tracker()


def get_provider_registry(request: Request) -> ProviderRegistry:
    return request.app.state.container.get_provider_registry()


def resolve_identity_tokens(request: Request) -> TokenStore:
    return request.app.state.container.get_token_store()


def get_user_track_store(request: Request) -> UserTrackStore:
    return request.app.state.container.get_user_track_store()


def get_browse_service(request: Request) -> BrowseService:
    return request.app.state.container.get_browse_service()


def get_ownership_index(request: Request):
    return request.app.state.container.get_ownership_index()


def get_track_relocator(request: Request):
    return request.app.state.container.get_track_relocator()


def get_library_scope(request: Request) -> LibraryScope:
    from app.infra.identity import current_principal
    from app.domains.user_library.scope import ScopeCache

    principal = current_principal(request)
    container = get_container(request)
    cache = container.singleton('library_scope_cache', ScopeCache)
    return cache.get(principal, get_user_track_store(request), container.changes)


def reset_account_password(argv: list[str]) -> None:
    """Compose the account recovery CLI without starting the HTTP server."""
    from app.domains.accounts.recovery import reset_password

    reset_password(argv)


def get_analysis_service(request: Request):
    return get_container(request).get_analysis_service()


def get_tag_edits(request: Request):
    return get_container(request).get_tag_edits()


def get_missing_files(request: Request):
    return get_container(request).get_missing_files()


def get_match_service(request: Request):
    return get_container(request).get_match_service()


def get_duplicate_service(request: Request):
    return get_container(request).get_duplicate_service()
