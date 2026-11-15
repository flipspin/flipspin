"""Only explicit wire/storage aliases may name the retired built-in source."""
import re
from pathlib import Path

CORE = Path(__file__).resolve().parents[2] / 'app'
PATTERN = re.compile(r'yt_dlp|ytdlp|youtube', re.IGNORECASE)

# Exact stripped lines, each with its compatibility reason. Never allow imports,
# tool paths or even quoted occurrences of the forbidden extractor module.
ALLOWLIST = [
    ('domains/acquisition/sources/known.py', "LEGACY_SOURCE_ID: (['Songs', 'AAC', 'm4a', 'official'], 'https://github.com/flipspin/flipspin-source-youtube'),", 'Catalog metadata for the owner-selected source install; no provider code.'),
    ('config.py', '"source_cookies_from_browser": os.getenv("KROBI_YTDLP_COOKIES_FROM_BROWSER") or None,', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('config.py', '"source_cookies_file": os.getenv("KROBI_YTDLP_COOKIES_FILE") or None,', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('dependencies.py', "'/api/download-youtube-url', '/api/download-search', '/api/download-spotify-playlist',", 'Keep the legacy download route path.'),
    ('domains/acquisition/adapters.py', 'youtube_url=url,', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'self, progress_id: str, index: int, youtube_url: str', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'return replace(request, search_query=None, youtube_url=youtube_url)', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'youtube_url=resolved.url,', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'youtube_url: str,', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'youtube_url=youtube_url,', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'self.download_repo.select(request.youtube_url)', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'if request.youtube_url:', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'self.logger.info(f"Using direct source URL: {request.youtube_url}")', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'return ResolvedVideo(request.youtube_url, "direct URL")', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/engine.py', 'url=youtube_url,', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/models.py', 'youtube_url: SourceURL | None = Field(default=None, min_length=1, max_length=500)', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/models.py', 'youtube_url: SourceURL | None = Field(default=None, max_length=2000)', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/provider.py', '"Point KROBI_YTDLP_COOKIES_FILE at a readable Netscape-format cookies.txt "', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('domains/acquisition/provider.py', 'resolved = _usable_cookies_file(config_cookies_file, "settings/KROBI_YTDLP_COOKIES_FILE")', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('domains/acquisition/request_job.py', "labels = [r.metadata.title or r.search_query or r.youtube_url or 'Canción' for r in requests]", 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/services.py', "if selection.index not in failures or not failures[selection.index]['detail'].get('retryable', True) or (selection.youtube_url is not None and failures[selection.index]['reason'] not in ('no-encontrada', 'fallo-descarga')):", 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/services.py', 'if selection.youtube_url is not None:', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/services.py', "body.setdefault('_source_urls', {})[str(selection.index)] = selection.youtube_url", 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/services.py', "job = self.store.stage(id, stage, [{'item': r.metadata.title or r.search_query or r.youtube_url or 'Canción',", 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/services.py', 'search_query=None if track.get(\'youtube_url\') else f"{track[\'title\']} {track.get(\'artist\', \'\')}".strip(),', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/services.py', "youtube_url=track.get('youtube_url'),", 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/services.py', "requests = [replace(req, youtube_url=work['body']['_source_urls'][str(i)], search_query=None)", 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/services.py', 'self.engine.download_repo.select(req.youtube_url)', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/acquisition/sources/compat.py', "LEGACY_SOURCE_ID = 'youtube'", 'Keep saved provider ids and the generic legacy-source migration table.'),
    ('domains/acquisition/sources/compat.py', "LEGACY_SOURCES = {LEGACY_SOURCE_ID: ('YouTube', 'KROBI_SOURCE_LOCATION_YOUTUBE')}", 'Keep saved provider ids and the generic legacy-source migration table.'),
    ('domains/acquisition/sources/compat.py', 'return "YouTube Downloads" if source.id == LEGACY_SOURCE_ID else f"{source.manifest[\'name\']} Downloads"', 'Keep saved provider ids and the generic legacy-source migration table.'),
    ('domains/downloads/routes.py', 'class YoutubeDownloadRequest(BaseModel):', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'def _source_custom_filename(data: YoutubeDownloadRequest) -> str | None:', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', '@router.post("/download-youtube-url", dependencies=[Depends(require_source)], operation_id=\'download_youtube_url_api_download_youtube_url_post\')', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/downloads/routes.py', 'data: YoutubeDownloadRequest,', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'class YouTubeSearchRequest(BaseModel):', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'class YouTubeSearchResult(BaseModel):', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'class YouTubeSearchResponse(BaseModel):', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'results: list[YouTubeSearchResult]', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', '@router.post("/downloads/youtube-search", response_model=YouTubeSearchResponse, dependencies=[Depends(require_source)], operation_id=\'youtube_search_api_downloads_youtube_search_post\')', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'data: YouTubeSearchRequest,', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'YouTubeSearchResult(', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'return YouTubeSearchResponse(query=query, results=results)', 'Keep the legacy URL/search request and response schema ids.'),
    ('domains/downloads/routes.py', 'youtube_url: SourceURL = Field(..., min_length=1, max_length=500)', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/downloads/routes.py', 'request = engine.retry_request(data.progress_id, data.index, data.youtube_url) if permitted else None', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/downloads/routes.py', 'label = request.metadata.title or data.youtube_url', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/downloads/routes.py', 'logger.info("Retry of %s#%d requested by %s from %s", data.progress_id, data.index, principal, data.youtube_url)', 'Keep the shipped direct URL input and persisted request field.'),
    ('domains/system/routes.py', 'class YtdlpCookiesRequest(BaseModel):', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('domains/system/routes.py', '@router.get("/config/ytdlp-cookies")', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('domains/system/routes.py', 'def get_ytdlp_cookies_config(config: ConfigManager = Depends(get_config)):', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('domains/system/routes.py', '@router.put("/config/ytdlp-cookies", dependencies=[Depends(require_owner)])', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('domains/system/routes.py', 'def put_ytdlp_cookies_config(data: YtdlpCookiesRequest, config: ConfigManager = Depends(get_config)):', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('domains/system/routes.py', 'env_sources.require_unlocked("KROBI_YTDLP_COOKIES_FROM_BROWSER", "KROBI_YTDLP_COOKIES_FILE")', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('domains/system/routes.py', '"KROBI_YTDLP_COOKIES_FROM_BROWSER": browser, "KROBI_YTDLP_COOKIES_FILE": cookies_file,', 'Keep the cookie route, environment aliases and their schema ids.'),
    ('infra/job_requests.py', "return {'item': request.metadata.title or request.search_query or request.youtube_url or 'Canción',", 'Keep the shipped direct URL input and persisted request field.'),
    ('infra/job_requests.py', "ledger.configure(job_id, label=' · '.join(x for x in (metadata.title, metadata.artist) if x) or requests[0].search_query or requests[0].youtube_url)", 'Keep the shipped direct URL input and persisted request field.'),
    ('infra/media_requests.py', 'youtube_url: str | None = None   # For direct URL downloads', 'Keep the shipped direct URL input and persisted request field.'),
    ('infra/media_requests.py', 'if not self.search_query and not self.youtube_url:', 'Keep the shipped direct URL input and persisted request field.'),
    ('infra/media_requests.py', 'return False, "Either search_query or youtube_url must be provided"', 'Keep the shipped direct URL input and persisted request field.'),
    ('infra/media_requests.py', 'if self.search_query and self.youtube_url:', 'Keep the shipped direct URL input and persisted request field.'),
    ('infra/media_requests.py', 'return False, "Cannot provide both search_query and youtube_url"', 'Keep the shipped direct URL input and persisted request field.'),
    ('providers/routes.py', 'class YtdlpResponse(BaseModel):', 'Keep the legacy action response and optional provider schema for wire compatibility.'),
    ('providers/routes.py', "@router.post('/providers/youtube/ytdlp/update', response_model=YtdlpResponse,", 'Keep the legacy owner tool-action route and response schema.'),
    ('providers/routes.py', "response_model_exclude_unset=True, dependencies=[Depends(require_owner)], operation_id='update_ytdlp_api_providers_youtube_ytdlp_update_post')", 'Keep the legacy download route path.'),
    ('providers/routes.py', 'ytdlp: YtdlpResponse | None = None', 'Keep the legacy action response and optional provider schema for wire compatibility.'),
 ]


def violations(root, allowlist=ALLOWLIST):
    allowed = {(path, line) for path, line, reason in allowlist if reason}
    found = []
    for path in sorted(root.rglob('*')):
        if not path.is_file() or '__pycache__' in path.parts:
            continue
        try:
            lines = path.read_text(encoding='utf-8').splitlines()
        except UnicodeError:
            continue
        for number, line in enumerate(lines, 1):
            if not PATTERN.search(line):
                continue
            if 'yt_dlp' in line.lower() or (str(path.relative_to(root)), line.strip()) not in allowed:
                found.append(f'{path.relative_to(root)}:{number}:{line}')
    return found


def test_core_has_only_explicit_compatibility_aliases():
    assert not violations(CORE), '\n'.join(violations(CORE))


def test_extractor_module_is_never_allowlistable(tmp_path):
    for text in ('import yt_dlp', 'tool = "yt_dlp"', 'path = "vendor/yt_dlp/main.py"'):
        (tmp_path / 'example.py').write_text(text)
        assert violations(tmp_path, [('example.py', text, 'Even an explicit entry cannot admit this module.')])
