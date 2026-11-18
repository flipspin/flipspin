"""One read-only comparison with the old cache, before that cache is discarded."""
import json
import logging
import threading
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.id3 import ID3, ID3NoHeaderError

from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_tags import analysis_tags, tag_value
from app.utils.library_paths import rel_path_for


def _matches(path: Path, entry: dict) -> bool:
    if path.suffix.lower() not in ('.mp3', '.flac', '.ogg'):
        return False
    try:
        tags = ID3(path) if path.suffix.lower() == '.mp3' else getattr(MutagenFile(path), 'tags', None)
    except ID3NoHeaderError:
        return False
    if tags is None or entry.get('bpm') is None or analysis_tags(tags)['bpm'] != round(entry['bpm']):
        return False
    tonic = entry.get('key')
    compact = f'{tonic}m' if entry.get('scale') == 'minor' and tonic else tonic
    names = (('TKEY', compact), ('TXXX:INITIALKEY', entry.get('camelot'))) if path.suffix.lower() == '.mp3' else (
        ('initialkey', entry.get('key_name')), ('camelot', entry.get('camelot')))
    found = False
    for name, expected in names:
        actual = tag_value(tags, (name,))
        if actual is not None:
            if expected is None or actual != expected:
                return False
            found = True
    return found


def migrate_legacy_tags(config, repository: AnalysisRepository) -> dict | None:
    """Commit the ownership rows and completion summary together, then unlink.

    A failed/interrupted comparison commits nothing and leaves the cache for a
    retry on the next boot. A crash after commit needs only the final unlink.
    """
    cache = config.temp_dir / 'audio_analysis_cache.json'
    done = repository.meta('legacy_tags_checked')
    if done is not None:
        cache.unlink(missing_ok=True)
        return None
    if not cache.exists():
        return None
    entries = json.loads(cache.read_text(encoding='utf-8'))
    if not isinstance(entries, dict):
        raise ValueError('Legacy analysis cache must be an object')
    rows = []
    summary = {'entries': len(entries), 'matched': 0, 'skipped': 0}
    for filename, entry in entries.items():
        path = Path(filename)
        rel_path = rel_path_for(config.base_music_dir, path)
        try:
            stat = path.stat()
        except FileNotFoundError:
            summary['skipped'] += 1
            continue
        if (rel_path is None or not path.is_file() or entry.get('size') != stat.st_size
                or entry.get('mtime_ns') != stat.st_mtime_ns or not _matches(path, entry)):
            summary['skipped'] += 1
            continue
        # A concurrent retag invalidates the comparison; leave it for a fresh pass.
        after = path.stat()
        if (after.st_size, after.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
            raise RuntimeError('Audio changed during legacy tag comparison')
        rows.append((rel_path, stat.st_size, stat.st_mtime_ns))
        summary['matched'] += 1
    repository.mark_legacy_tags(rows, json.dumps(summary, sort_keys=True))
    cache.unlink()
    return summary


def start_legacy_tag_check(config, repository_factory, on_complete) -> threading.Thread:
    """Startup schedules the pass; no tag reads delay boot."""
    def run():
        try:
            migrate_legacy_tags(config, repository_factory())
            on_complete()
        except Exception:
            logging.getLogger(__name__).exception('Legacy analysis tag check will retry next boot')
    thread = threading.Thread(target=run, name='legacy-analysis-tags', daemon=True)
    thread.start()
    return thread
