"""Lyrics: where a song's words come from, and where they are stored.

Two ways in — a catalog (LRCLIB, Genius) through the ``LYRICS`` provider kind,
or (later) transcription and alignment on the user's own machine — and one way
out: a sidecar next to the audio file, plus one JSON index that remembers where
each lyric came from. See ``services.py`` for the rules.
"""
