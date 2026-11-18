"""The writer guard fails closed for new save sites, including chained calls."""
import runpy
from pathlib import Path

import pytest

CHECKER = Path(__file__).resolve().parents[3] / 'scripts/check-tag-writes.py'


@pytest.mark.parametrize('source', ['audio.save(path)', 'tags.save(path)', 'MutagenFile(path).save()'])
def test_guard_rejects_new_save_sites(tmp_path, source):
    path = tmp_path / 'domains/music/unsafe.py'
    path.parent.mkdir(parents=True)
    path.write_text(source)
    check = runpy.run_path(str(CHECKER))['violations']
    assert check(tmp_path) == ['domains/music/unsafe.py:1: save must use the shared tag writer']


def test_guard_allows_writer_and_known_non_tag_stores(tmp_path):
    for name, source in [('domains/metadata/tagwriter.py', 'audio.save(temporary)'),
                         ('domains/lyrics/services.py', 'self.save(rel_path, text=text)')]:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
    assert runpy.run_path(str(CHECKER))['violations'](tmp_path) == []
