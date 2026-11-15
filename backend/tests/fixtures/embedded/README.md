These are original fixtures containing 0.15 seconds of generated silence and
generic tags. `front.png` is an original one-pixel RGB image. No music,
downloaded artwork or third-party lyrics are included.

From `backend/`, regenerate with the repository virtualenv:

```sh
../.venv/bin/python -m tests.fixtures.embedded.generate
```

- `uslt.mp3`: ID3 USLT, front PNG APIC and back APIC (front must win).
- `sylt.mp3`: the same tags plus millisecond SYLT (synced must win).
- `picture.flac`: native PICTURE and Vorbis LYRICS.
- `covr.m4a`: MP4 covr and ©lyr.
- `vorbis.ogg`: Vorbis METADATA_BLOCK_PICTURE and UNSYNCEDLYRICS.

`generate.py` uses the app's ffmpeg resolver and mutagen; the tests consume the
checked-in audio files directly. They also mutate copies for invalid tags,
MPEG-frame SYLT, retags, alternate lyric keys, and image size limits.
