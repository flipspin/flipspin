"""Plain lyrics from the public Lyrics.ovh API, cached to avoid repeat fetches."""
from collections import OrderedDict
import threading
import time
from urllib.parse import quote

import requests

from app.config import APP_VERSION
from app.domains.lyrics.models import LyricsCandidate


class LyricsOvhProvider:
    def __init__(self, session=None):
        self.session = session or requests.Session()
        self._cache = OrderedDict()
        self._lock = threading.Lock()

    def search_lyrics(self, query):
        if not query.artist or not query.title:
            return []
        key = (query.artist, query.title)
        with self._lock:
            cached = self._cache.get(key)
            if cached and time.monotonic() - cached[0] < 3600:
                text = cached[1]
            else:
                url = f"https://api.lyrics.ovh/v1/{quote(query.artist, safe='')}/{quote(query.title, safe='')}"
                response = self.session.get(url, timeout=12, headers={
                    "User-Agent": f"Flipspin/{APP_VERSION} ( https://github.com/flipspin/flipspin )",
                })
                if response.status_code == 404:
                    return []
                response.raise_for_status()
                data = response.json()
                text = data.get("lyrics") if isinstance(data, dict) else None
                if not isinstance(text, str) or not text.strip():
                    return []
                text = text.strip()
                self._cache[key] = (time.monotonic(), text)
                self._cache.move_to_end(key)
                while len(self._cache) > 256:
                    self._cache.popitem(last=False)
        return [LyricsCandidate(
            provider="lyricsovh", title=query.title, artist=query.artist,
            plain_lyrics=text, provider_ref=f"lyricsovh:{query.artist}/{query.title}",
            url="https://lyrics.ovh/",
        )]
