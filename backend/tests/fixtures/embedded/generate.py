"""Regenerate tiny, original silent audio fixtures: run from backend/."""
import base64
import struct
import subprocess
import zlib
from pathlib import Path

from mutagen import File
from mutagen.flac import Picture
from mutagen.id3 import APIC, SYLT, USLT, TALB, TIT2, TPE1
from mutagen.mp4 import MP4Cover

from app.infra.ffmpeg import resolve_ffmpeg

DIRECTORY = Path(__file__).parent
WORDS = "First café line\nSecond line"


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


PNG = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
PNG += chunk(b"IDAT", zlib.compress(b"\x00\x20\x70\xd0")) + chunk(b"IEND", b"")
(DIRECTORY / "front.png").write_bytes(PNG)

for name in ("uslt.mp3", "sylt.mp3", "picture.flac", "covr.m4a", "vorbis.ogg"):
    path = DIRECTORY / name
    subprocess.run(
        [resolve_ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
         "-t", "0.15", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", str(path)],
        check=True,
    )
    audio = File(path)
    if path.suffix == ".mp3":
        audio.tags.clear()
        audio.tags.add(TIT2(encoding=3, text="Fixture Song"))
        audio.tags.add(TPE1(encoding=3, text="Fixture Artist"))
        audio.tags.add(TALB(encoding=3, text="Fixture Album"))
        # The back cover sorts first; front-cover preference must override it.
        audio.tags.add(APIC(encoding=3, mime="image/jpeg", type=4, desc="back", data=b"\xff\xd8\xffback"))
        audio.tags.add(APIC(encoding=3, mime="image/png", type=3, desc="front", data=PNG))
        audio.tags.add(USLT(encoding=3, lang="eng", desc="", text=WORDS))
        if name == "sylt.mp3":
            audio.tags.add(SYLT(encoding=3, lang="eng", format=2, type=1, desc="",
                                text=[("First café line", 1250), ("Second line", 61234)]))
    elif path.suffix == ".m4a":
        audio.tags.clear()
        audio["©nam"] = ["Fixture Song"]
        audio["©ART"] = ["Fixture Artist"]
        audio["©alb"] = ["Fixture Album"]
        audio["covr"] = [MP4Cover(PNG, imageformat=MP4Cover.FORMAT_PNG)]
        audio["©lyr"] = [WORDS]
    else:
        audio.tags.clear()
        audio["TITLE"] = ["Fixture Song"]
        audio["ARTIST"] = ["Fixture Artist"]
        audio["ALBUM"] = ["Fixture Album"]
        picture = Picture()
        picture.type, picture.mime, picture.width, picture.height, picture.depth = 3, "image/png", 1, 1, 24
        picture.data = PNG
        if path.suffix == ".flac":
            audio.add_picture(picture)
            audio["LYRICS"] = [WORDS]
        else:
            audio["METADATA_BLOCK_PICTURE"] = [base64.b64encode(picture.write()).decode()]
            audio["UNSYNCEDLYRICS"] = [WORDS]
    audio.save()
