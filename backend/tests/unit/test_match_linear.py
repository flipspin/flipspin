"""Progress bookkeeping visits each manifest position once, including equal rows."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.music.match_service import MatchService


@pytest.mark.parametrize('fail', [False, True])
def test_two_thousand_equal_rows_keep_distinct_indices_in_linear_work(fail):
    comparisons = 0
    class Row(dict):
        def __eq__(self, other):
            nonlocal comparisons
            comparisons += 1
            return super().__eq__(other)
    files = [Row(relPath='Album/song.mp3', now={}) for _ in range(2000)]
    service = object.__new__(MatchService)
    service.stored = Mock(return_value={'request': {'files': files, 'album': False, 'query': None, 'link': None}})
    service.active = Mock(return_value=True)
    service.tracker = Mock()
    service.ledger = Mock()
    service.ledger.items.return_value = []
    service.provider = SimpleNamespace(search_recordings=Mock(return_value=[]))
    if fail:
        service.provider.search_recordings.side_effect = RuntimeError('provider unavailable')
    service.store_candidates = Mock()
    service.run('job')
    assert comparisons == 0
    assert service.provider.search_recordings.call_count == 2000
    transitions = service.ledger.item_transition.call_args_list
    assert len(transitions) == 2000
    assert [call.args[1] for call in transitions] == list(range(2000))
    assert all(call.args[3] == ('failed' if fail else 'done') for call in transitions)
