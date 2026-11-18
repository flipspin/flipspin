"""One paced, restartable notation upgrade; never a new analysis decision."""
import logging
import threading
from pathlib import Path

from app.domains.metadata import tagwriter
from app.domains.music.analysis_tags import analysis_tags, tag_value
from app.domains.music.analysis_writeback import owned_tags
from app.domains.music.library_files import walk_library
from app.domains.music.tag_edits import TagEdits
from app.utils.library_paths import rel_path_for
from app.utils.musical_key import key_info

logger = logging.getLogger(__name__)
KEY_TAG_VERSION = '1'
PAUSE_SECONDS = 0.1
_LOCK = threading.Lock()


class KeyTagMigration:
    def __init__(self, config, repository, music, worker, scan_lock, stop):
        self.config, self.repository, self.music = config, repository, music
        self.worker, self.scan_lock, self.stop = worker, scan_lock, stop
        self.edits = TagEdits(config, repository, music)

    def run(self):
        if not self.config.write_analysis_tags:
            return True
        while not _LOCK.acquire(blocking=False):
            if self.stop.wait(PAUSE_SECONDS):
                return False
        counts = dict.fromkeys(('rewritten', 'untouched', 'failed'), 0)
        complete = False
        try:
            if self.repository.meta('key_tag_version') == KEY_TAG_VERSION:
                complete = True
                return True
            def unreadable(error):
                raise error

            paths = sorted(Path(root) / name
                           for root, _, files in walk_library(self.config.base_music_dir, onerror=unreadable)
                           for name in files if not name.startswith('.') and Path(name).suffix.lower() in tagwriter.FORMATS)
            if not paths:
                return True  # An empty/unmounted library is not a completed migration.
            for path in paths:
                while not self.scan_lock.acquire(blocking=False):
                    if self.stop.wait(PAUSE_SECONDS):
                        return False
                try:
                    if self.stop.is_set():
                        return False
                    with self.worker.lock:
                        counts[self.rewrite_file(path)] += 1
                except Exception:
                    counts['failed'] += 1
                    raise
                finally:
                    self.scan_lock.release()
                if self.stop.wait(PAUSE_SECONDS):
                    return False
            if self.stop.is_set():
                return False
            self.repository.key_tags_rewritten(KEY_TAG_VERSION)
            self.music.invalidate_scan()
            complete = True
            return True
        finally:
            logger.info('Key tag notation: rewritten=%d untouched=%d failed=%d complete=%s',
                        counts['rewritten'], counts['untouched'], counts['failed'], complete)
            _LOCK.release()

    def rewrite_file(self, path):
        rel = rel_path_for(self.config.base_music_dir, path)
        if not rel or path.suffix.lower() not in tagwriter.FORMATS or not path.is_file():
            return 'untouched'
        with tagwriter.file_lock(path):
            row = self.repository.get(rel)
            if not row:
                return 'untouched'  # A stale marker alone cannot disprove an outside correction.
            fields = self.repository.tag_fields(rel)
            if (fields is not None and 'key' not in fields) or (fields is None and row.get('tag_owner') != 'krobi'):
                return 'untouched'
            recorded = self.repository.tag_record(rel, 'tag_values')
            expected = recorded.get('key', row.get('fixed_key') or row.get('key'))

            def plan(tags, mode):
                marker = tag_value(tags, (tagwriter.FIELDS['analysisMarker'][mode],)) is not None
                if fields is not None:
                    if 'key' not in fields:
                        return {}
                elif not marker or row.get('tag_owner') != 'krobi':
                    return {}
                if fields is None and not owned_tags(row, analysis_tags(tags), values=recorded):
                    return {}  # Legacy ownership covers both fields; don't adopt an edited sibling.
                names = (tagwriter.FIELDS['key'][mode], *tagwriter.ALIASES.get(('key', mode), ()))
                if any(len(getattr(tags[name], 'text', tags[name])) != 1 for name in names if name in tags):
                    return {}  # Never collapse someone else's multi-value key frame.
                raw = [tag_value(tags, (name,)) for name in names if name in tags]
                # Check every alias: a foreign/hand-corrected sibling must survive too.
                if not raw or any(not value or key_info(value)['camelot'] != expected for value in raw):
                    return {}
                if not any(value.strip().upper() == expected for value in raw):
                    return {}  # Already note names: retries never replace this file again.
                companion = tag_value(tags, (tagwriter.FIELDS['camelot'][mode],))
                if companion is not None and companion != expected:
                    return {}  # A later edit to the private frame must not be overwritten.
                return {'key': expected}

            provenance = lambda: {'owner': row.get('tag_owner'), 'fields': fields}
            observed = path.stat()
            _, tags, mode = tagwriter.load(path)
            identity = tagwriter.identity(path, tags, mode, observed)
            version = tags.version[1] if mode == 0 and tags.version[1] in (3, 4) else 4
            result = self.edits.edit(path, {}, expected=identity, transform=plan, id3_version=version,
                                     principal='key-tag-migration', provenance=provenance)
            return 'rewritten' if result['changed'] else 'untouched'
