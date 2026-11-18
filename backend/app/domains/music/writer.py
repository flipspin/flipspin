"""Protected publication port. Only the acquisition import stage calls this API."""
import logging
import hashlib
import os
import shutil
import uuid
from pathlib import Path

from app.utils.path_safety import safe_open_path, resolve_under
from app.domains.music.publish_events import expected_publishes
from app.infra.files import SHARED


def publish(staged: Path, destination: Path, *, root: Path, incoming: Path, recycle: Path,
            overwrite=True, before_publish=None) -> Path:
    staged = safe_open_path(incoming, staged)
    root.mkdir(parents=True, exist_ok=True)
    destination = resolve_under(root, *destination.resolve().relative_to(root.resolve()).parts)
    if not staged.is_file():
        raise ValueError('missing-audio')
    parents = []
    parent = destination
    while parent.is_relative_to(root.resolve()):
        parents.append(parent)
        expected_publishes.expect(parent)
        if parent == root.resolve():
            break
        parent = parent.parent
    destination.mkdir(parents=True, exist_ok=True)
    final = resolve_under(root, *destination.relative_to(root.resolve()).parts, staged.name)
    # Keep the final publication atomic on either mount layout.
    temporary = destination / f'.import-{uuid.uuid4().hex}'
    backup = None
    published = False
    moved = False
    try:
        if staged.stat().st_dev == destination.stat().st_dev:
            os.replace(staged, temporary)
            moved = True
        else:
            with staged.open('rb') as source, temporary.open('xb') as target:
                shutil.copyfileobj(source, target)
                target.flush()
                os.fsync(target.fileno())
        os.chmod(temporary, SHARED)
        if overwrite:
            if final.exists():
                recycle.mkdir(parents=True, exist_ok=True)
                backup = recycle / f'{uuid.uuid4().hex}-{final.name}'
                shutil.copy2(final, backup)
            if before_publish is not None:
                before_publish(final)
            expected_publishes.expect(final)
            os.replace(temporary, final)
            expected_publishes.landed(final)
        else:
            with temporary.open('rb') as source:
                sha = hashlib.file_digest(source, 'sha256').digest()
            number = 1
            while True:
                if final.exists():
                    existing = safe_open_path(root, final)
                    if existing.is_file():
                        with existing.open('rb') as source:
                            if hashlib.file_digest(source, 'sha256').digest() == sha:
                                if before_publish is not None:
                                    before_publish(final, already_present=True)
                                published = True
                                staged.unlink(missing_ok=True)
                                return final
                    number += 1
                    final = resolve_under(root, *destination.relative_to(root.resolve()).parts,
                                          f'{staged.stem} ({number}){staged.suffix}')
                    continue
                if before_publish is not None:
                    before_publish(final)
                try:
                    # The temporary lives on the destination mount. Linking it
                    # publishes complete bytes atomically and cannot overwrite
                    # a file that appeared after the existence check.
                    expected_publishes.expect(final)
                    os.link(temporary, final)
                    expected_publishes.landed(final)
                    break
                except FileExistsError:
                    continue
        published = True
        staged.unlink(missing_ok=True)
        cover = staged.parent / 'cover' / 'cover.jpg'
        if cover.is_file():
            # Staging uses cover/ for embedding; only the sidecar belongs in
            # the album. Audio is already published; artwork must not undo it.
            cover_tmp = None
            try:
                cover_dest = resolve_under(root, *destination.relative_to(root.resolve()).parts, 'cover.jpg')
                if not cover_dest.exists():
                    cover_tmp = cover_dest.with_name(f'.cover-{uuid.uuid4().hex}')
                    shutil.copy2(cover, cover_tmp)
                    expected_publishes.expect(cover_dest)
                    os.replace(cover_tmp, cover_dest)
                    expected_publishes.landed(cover_dest)
            except Exception:
                logging.getLogger(__name__).warning('Could not publish album artwork', exc_info=True)
            finally:
                if cover_tmp is not None:
                    cover_tmp.unlink(missing_ok=True)
        return final
    finally:
        # Restore the staged input on a failed publication for durable retry.
        if not published and moved and temporary.exists():
            os.replace(temporary, staged)
        temporary.unlink(missing_ok=True)
        if published:
            # Removing the sibling after link-based publication changes ctime.
            expected_publishes.landed(final)
        for parent in parents:
            expected_publishes.landed(parent)
