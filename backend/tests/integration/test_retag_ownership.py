"""Ownership follows real listing refreshes after an external in-place retag."""
import os
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mutagen.id3 import ID3, TIT2, TPE1

from app.dependencies import DependencyContainer, get_library_scope
from app.domains.music import repositories
from app.domains.music.routes import router
from app.domains.music.scan_worker import ScanWorker
from app.domains.user_library.scope import LibraryScope

pytestmark = pytest.mark.integration
FRAME = (b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40


@pytest.mark.parametrize("refresh", ["periodic", "invalidate", "tag_read"])
@pytest.mark.parametrize("folder", ["Album", "Artist/Album/CD1"])
def test_ownership_follows_listing_after_in_place_retag(config, refresh, folder):
    song = config.base_music_dir / folder / "01.mp3"
    song.parent.mkdir(parents=True)
    for path, title in ((song, "Old title"), (song.with_name("02.mp3"), "Unchanged")):
        path.write_bytes(FRAME)
        tags = ID3()
        tags.add(TIT2(encoding=3, text=[title]))
        tags.add(TPE1(encoding=3, text=["Artist"]))
        tags.save(path, padding=lambda _: 2048)

    container = DependencyContainer(config)
    repo = container.get_music_repository()
    repo.scans.worker = ScanWorker(repo)
    app = FastAPI()
    app.state.container = container
    app.dependency_overrides[get_library_scope] = lambda: LibraryScope()
    app.include_router(router)

    with TestClient(app) as client, patch.object(
        repositories, "MutagenFile", wraps=repositories.MutagenFile
    ) as reads:
        def listing_title():
            response = client.get("/api/listar-albums-con-metadata", params={"covers": "false"})
            assert response.status_code == 200
            return next(t["title"] for a in response.json() for t in a["tracks"] if t["path"] == str(song))

        def ownership():
            response = client.post("/api/library/ownership", json={"tracks": [
                {"artist": "Artist", "title": title} for title in ("Old title", "New title")
            ]})
            assert response.status_code == 200
            assert not response.json().get("degraded")
            return [r["owned"] for r in response.json()["results"]]

        repo.refresh()
        assert listing_title() == "Old title"
        assert ownership() == [True, False]
        assert reads.call_count == 2
        before = song.stat()
        signature = repositories.library_signature(config.base_music_dir)
        tags = ID3(song)
        tags.add(TIT2(encoding=3, text=["New title"]))
        tags.save(song, padding=lambda _: 2048)
        os.utime(song, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000_000))
        after = song.stat()
        assert after.st_ino == before.st_ino
        assert after.st_size == before.st_size
        assert after.st_mtime_ns != before.st_mtime_ns
        assert repositories.library_signature(config.base_music_dir) == signature
        assert listing_title() == "Old title"
        assert ownership() == [True, False]
        assert reads.call_count == 2

        if refresh == "invalidate":
            repo.invalidate_scan()
        elif refresh == "tag_read":
            revision = repo.tag_revision
            assert repo.read_tags(song)["title"] == "New title"
            assert repo.tag_revision == revision  # Memo misses never invalidate the listing.
        repo.refresh(reason=refresh)
        assert listing_title() == "New title"
        assert ownership() == [False, True]
        assert reads.call_count == 3  # Only the retagged file was reopened.
        repo.invalidate_scan()
        repo.refresh()
        assert listing_title() == "New title"
        assert ownership() == [False, True]
        assert reads.call_count == 3
