#!/usr/bin/env python3
"""Compare provider album tracklists, playlist tracklists, and search identities.

This manual probe measures responses, latency, and identity fields; it never
downloads audio. Run with the repository virtualenv.
"""
import os
import time
from typing import Any, Dict, List, Optional

import requests

# MusicBrainz REQUIRES a descriptive User-Agent with contact info and enforces
# ~1 req/s. Omitting it gets you 403'd, which is the single most common reason
# a MusicBrainz integration "mysteriously stops working". Put a real contact
# URL or address here -- a placeholder is as good as no User-Agent to them.
MB_UA = os.environ.get(
    "KROBI_MB_USER_AGENT",
    "Flipspin/0.1.0-rc.15 ( https://github.com/flipspin/flipspin )",
)
MB = "https://musicbrainz.org/ws/2"
DEEZER = "https://api.deezer.com"

ALBUM_ARTIST, ALBUM_TITLE = "Daft Punk", "Random Access Memories"
TRACK_QUERY = "Daft Punk Get Lucky"
# Small public playlists, chosen so a failure is about the API and not the size.
DEEZER_PLAYLIST_ID = "1313621735"  # Deezer editorial playlist

results: List[Dict[str, Any]] = []


def record(provider: str, question: str, ok: bool, detail: str,
           elapsed: float, fields: Optional[str] = None) -> None:
    results.append({
        "provider": provider, "q": question, "ok": ok,
        "detail": detail, "ms": int(elapsed * 1000), "fields": fields or "",
    })
    flag = "OK  " if ok else "FAIL"
    print(f"  [{flag}] {question:22} {int(elapsed*1000):>6}ms  {detail}")
    if fields:
        print(f"         fields: {fields}")


# --------------------------------------------------------------------------
# MusicBrainz — the identity backbone. No auth, no key, 1 req/s.
# --------------------------------------------------------------------------
def probe_musicbrainz() -> None:
    print("\nMusicBrainz  (no auth, no key, ~1 req/s)")
    h = {"User-Agent": MB_UA, "Accept": "application/json"}

    # Q1: album -> tracklist. Two hops: find the release, then read its media.
    t = time.time()
    try:
        r = requests.get(f"{MB}/release", headers=h, timeout=15, params={
            "query": f'artist:"{ALBUM_ARTIST}" AND release:"{ALBUM_TITLE}"',
            "fmt": "json", "limit": 3,
        })
        r.raise_for_status()
        rel = (r.json().get("releases") or [])[0]
        time.sleep(1.1)  # respect the rate limit between hops
        r2 = requests.get(f"{MB}/release/{rel['id']}", headers=h, timeout=15,
                          params={"inc": "recordings+artist-credits", "fmt": "json"})
        r2.raise_for_status()
        media = r2.json().get("media") or []
        tracks = [t2 for m in media for t2 in (m.get("tracks") or [])]
        first = tracks[0]
        record("musicbrainz", "Q1 album tracklist", True,
               f"{len(tracks)} tracks, first={first['title'][:34]!r}", time.time() - t,
               "recording MBID, position, length(ms), artist-credit")
    except Exception as e:
        record("musicbrainz", "Q1 album tracklist", False, f"{type(e).__name__}: {e}", time.time() - t)

    time.sleep(1.1)

    # Q2: playlists. MusicBrainz has no concept of a user playlist at all.
    record("musicbrainz", "Q2 playlist", False,
           "not applicable - MB models releases, not user playlists", 0.0)

    # Q3: search -> identity, including ISRC (the dedupe chain's bridge).
    t = time.time()
    try:
        r = requests.get(f"{MB}/recording", headers=h, timeout=15, params={
            "query": TRACK_QUERY, "fmt": "json", "limit": 3,
        })
        r.raise_for_status()
        rec = (r.json().get("recordings") or [])[0]
        record("musicbrainz", "Q3 track search", True,
               f"{rec['title']!r} score={rec.get('score')} mbid={rec['id'][:8]}...",
               time.time() - t, "recording MBID (the primary key), length, artist-credit, score")
    except Exception as e:
        record("musicbrainz", "Q3 track search", False, f"{type(e).__name__}: {e}", time.time() - t)


# --------------------------------------------------------------------------
# Deezer — public read API, no auth for public objects.
# --------------------------------------------------------------------------
def probe_deezer() -> None:
    print("\nDeezer public API  (no auth for public objects)")

    t = time.time()
    try:
        r = requests.get(f"{DEEZER}/search/album", timeout=15,
                         params={"q": f"{ALBUM_ARTIST} {ALBUM_TITLE}", "limit": 1})
        r.raise_for_status()
        alb = (r.json().get("data") or [])[0]
        r2 = requests.get(f"{DEEZER}/album/{alb['id']}", timeout=15)
        r2.raise_for_status()
        payload = r2.json()
        tracks = (payload.get("tracks") or {}).get("data") or []
        record("deezer", "Q1 album tracklist", True,
               f"{len(tracks)} tracks, first={tracks[0]['title'][:34]!r}", time.time() - t,
               f"deezer id, duration(s), isrc={payload.get('upc') is not None and 'upc@album' or '?'}, title, artist")
    except Exception as e:
        record("deezer", "Q1 album tracklist", False, f"{type(e).__name__}: {e}", time.time() - t)

    t = time.time()
    try:
        r = requests.get(f"{DEEZER}/playlist/{DEEZER_PLAYLIST_ID}", timeout=15)
        r.raise_for_status()
        p = r.json()
        if p.get("error"):
            raise RuntimeError(p["error"])
        tracks = (p.get("tracks") or {}).get("data") or []
        record("deezer", "Q2 playlist", True,
               f"{p.get('title','?')!r}: {len(tracks)} tracks returned", time.time() - t,
               "title, duration, artist, album, deezer track id")
    except Exception as e:
        record("deezer", "Q2 playlist", False, f"{type(e).__name__}: {e}", time.time() - t)

    t = time.time()
    try:
        r = requests.get(f"{DEEZER}/search", timeout=15, params={"q": TRACK_QUERY, "limit": 3})
        r.raise_for_status()
        hit = (r.json().get("data") or [])[0]
        r2 = requests.get(f"{DEEZER}/track/{hit['id']}", timeout=15)
        r2.raise_for_status()
        full = r2.json()
        record("deezer", "Q3 track search", True,
               f"{full['title']!r} dur={full.get('duration')}s isrc={full.get('isrc')}",
               time.time() - t, "ISRC present -> bridges to MusicBrainz recording")
    except Exception as e:
        record("deezer", "Q3 track search", False, f"{type(e).__name__}: {e}", time.time() - t)


if __name__ == "__main__":
    print("Probing Spotify replacements for KROBI's three metadata questions")
    print("=" * 72)
    for probe in (probe_musicbrainz, probe_deezer):
        try:
            probe()
        except Exception as e:  # a provider blowing up must not kill the run
            print(f"  provider aborted: {type(e).__name__}: {e}")

    print("\n" + "=" * 72)
    print(f"{'provider':<14}{'question':<24}{'ok':<6}{'ms':>7}")
    print("-" * 72)
    for r in results:
        print(f"{r['provider']:<14}{r['q']:<24}{str(r['ok']):<6}{r['ms']:>7}")
