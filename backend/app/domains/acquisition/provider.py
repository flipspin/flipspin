"""Legacy download API adapter over the registered SourcePort; no extractor code."""
import asyncio
import logging
import os
import subprocess
import threading
from collections import OrderedDict
from contextlib import contextmanager
from collections.abc import Callable
from contextvars import ContextVar
from pathlib import Path

from app.config import ConfigManager
from app.exceptions import DownloadError
from app.infra.capacity import _job
from app.infra.files import PRIVATE, write_json_atomic
from .audio import receipt
from .sources.port import SourcePort

logger = logging.getLogger(__name__)
_download_context = ContextVar('source_download_context', default=(None, None))
_defer_processing = ContextVar('defer_source_processing', default=False)


class DownloadCancelled(asyncio.CancelledError):
    """A stopped source call, reaped before staging is removed."""


@contextmanager
def source_download_context(track, cancelled=None, *, defer_processing=False):
    token = _download_context.set((track, cancelled))
    processing = _defer_processing.set(defer_processing)
    try:
        yield
    finally:
        _download_context.reset(token)
        _defer_processing.reset(processing)


def source_processing_deferred():
    return _defer_processing.get()


def source_download_track(fallback):
    return ' '.join((_download_context.get()[0] or fallback).split())[:200]


def _summarise_source_output(output):
    """Compatibility log formatter for typed source errors."""
    return ' '.join(str(output).split())[:500]


def _usable_cookies_file(raw: str, source: str) -> str | None:
    """Resolve a cookies.txt path, or None (with a clear log line) if unusable.

    A cookies file is the only cookie option that works on a headless server —
    ``--cookies-from-browser`` needs a real browser profile, which a Linux LXC
    running the backend does not have. So the path matters, and a stale or
    unreadable one must not be handed to source: source would abort the whole
    download with an opaque "unable to load cookies" error. Log why and continue
    without cookies instead, which at least succeeds whenever the default player
    client is enough.
    """
    path = Path(raw).expanduser()
    if not path.is_file():
        logger.warning(
            "source cookies file from %s not found: %s — continuing without cookies. "
            "Point KROBI_YTDLP_COOKIES_FILE at a readable Netscape-format cookies.txt "
            "on the machine running the backend.",
            source, path,
        )
        return None
    if not os.access(path, os.R_OK):
        logger.warning(
            "source cookies file from %s is not readable by the backend process: %s — "
            "continuing without cookies. Check file permissions/ownership.",
            source, path,
        )
        return None
    return str(path)


def _source_cookie_args(config: ConfigManager, cookies_file: str | None = None) -> list:
    """Choose one source cookie source without conflicting flags.

    A usable explicit file wins, then Settings prefers the live browser session
    over a manual file. Invalid files fall through; source validates browser profiles.
    """
    if cookies_file:
        resolved = _usable_cookies_file(cookies_file, "the download request")
        if resolved:
            return ["--cookies", resolved]
    browser = getattr(config, "source_cookies_from_browser", None)
    if browser:
        return ["--cookies-from-browser", browser]
    config_cookies_file = getattr(config, "source_cookies_file", None)
    if config_cookies_file:
        resolved = _usable_cookies_file(config_cookies_file, "settings/KROBI_YTDLP_COOKIES_FILE")
        if resolved:
            return ["--cookies", resolved]
    return []


class DownloadRepository:
    """Compatibility facade. The registry supplies the actual source port."""
    def __init__(self, config, logger, source: SourcePort | Callable[[], SourcePort] | None = None):
        self.config, self.logger = config, logger
        self._source = source
        self._selected = ContextVar("selected_source", default=None)
        self._direct = ContextVar("direct_source_url", default=False)
        self._candidates = OrderedDict()
        self._candidate_lock = threading.Lock()

    @property
    def source(self) -> SourcePort:
        if self._selected.get() is not None:
            return self._selected.get()
        if self._source is not None:
            return self._source if hasattr(self._source, 'fetch') or hasattr(self._source, 'search') else self._source()
        from .models import AcquisitionError
        raise AcquisitionError('no-sources', 409)

    def select(self, url=None):
        self._selected.set(None)
        source = self.source_for_url(url) if url else self.source
        self._selected.set(source)
        self._direct.set(url is not None)
        return source

    def source_for_url(self, url):
        return self._source(url) if callable(self._source) and not hasattr(self._source, "fetch") else self.source

    @property
    def source_id(self):
        return self.source.id

    def remember_candidates(self, rows):
        with self._candidate_lock:
            for row in rows:
                self._candidates[(self.source.id, row['url'])] = row['id']
            while len(self._candidates) > 1000:
                self._candidates.popitem(last=False)

    def options(self, cookies_file=None):
        args = _source_cookie_args(self.config, cookies_file)
        result = {'ffmpeg': self.config.ffmpeg_path}
        if args:
            result['cookiesFile' if args[0] == '--cookies' else 'cookiesBrowser'] = args[1]
        return result

    async def search_source(self, query, max_results=5, *, wanted=None):
        options = {**self.options(), 'query': query}
        return await self.source.search(wanted or {'title': query, 'artist': ''}, limit=max_results,
                                        deadline=30_000, options=options)

    async def download_source_audio(self, url, output_path, cookies_file=None, format='m4a',
                                     progress_cb=None, extract_audio=True):
        directory = output_path if output_path.is_dir() or not output_path.suffix else output_path.parent
        directory.mkdir(parents=True, exist_ok=True)
        _, cancelled = _download_context.get()
        job = _job.get()
        if cancelled is None and job and getattr(job[0], 'ledger', None):
            def cancelled():
                row = job[0].ledger.get(job[1])
                return not row or row['attempt'] != job[2] or row['state'] in ('cancelled', 'interrupted')
        with self._candidate_lock:
            candidate = url if self._direct.get() else self._candidates.get((self.source.id, url), url)
        task = asyncio.create_task(self.source.fetch(candidate, directory, deadline=int(self.config.download_timeout * 1000),
                                   options=self.options(cookies_file), progress=progress_cb))
        try:
            while not task.done():
                if cancelled and await asyncio.to_thread(cancelled):
                    raise DownloadCancelled()
                await asyncio.wait({task}, timeout=0.1)
            result = await task
        except asyncio.CancelledError:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            raise
        path = Path(result['path'])
        if directory != output_path:
            target = output_path.with_suffix('.m4a')
            if path != target:
                await asyncio.to_thread(path.replace, target)
            path = target
        await asyncio.to_thread(write_json_atomic, receipt(path),
                                {'source_codec': result.get('sourceCodec', result['codec']),
                                 'transcoded': result['transcoded']}, mode=PRIVATE)
        return path

    def close(self):
        pass

    def normalize_audio(
        self,
        file_path: Path,
        effect_type: str = "clean",
        volume_boost: float = 4.0
    ) -> None:
        """Measure ReplayGain and write tags without altering encoded audio."""
        import json
        import math
        from app.domains.metadata import tagwriter

        result = subprocess.run([
            self.config.ffmpeg_path, '-nostdin', '-i', str(file_path), '-map', '0:a:0',
            '-af', 'loudnorm=I=-18:print_format=json', '-f', 'null', '-',
        ], capture_output=True, timeout=self.config.download_timeout)
        try:
            output = result.stderr.decode(errors='replace')
            data = json.loads(output[output.rfind('{'):output.rfind('}') + 1])
            gain = -18 - float(data['input_i'])
            peak = 10 ** (float(data['input_tp']) / 20)
            if result.returncode or not math.isfinite(gain) or not math.isfinite(peak):
                raise ValueError('invalid loudness measurement')
            fields = {'trackGain': f'{gain:+.2f} dB', 'trackPeak': f'{peak:.8f}'}
            tagwriter.write(file_path, expected=tagwriter.identity(file_path),
                            transform=lambda tags, mode: tagwriter.fill_gaps(tags, mode, fields, overwrite=True))
        except (ValueError, KeyError) as error:
            raise DownloadError('Could not measure ReplayGain.') from error
