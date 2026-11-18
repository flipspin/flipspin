"""The shipped renderer calibration shares the server's confidence cutoffs."""
import json
from pathlib import Path

import pytest

from app.domains.music.analysis_constants import BPM_CONFIDENCE_THRESHOLD, KEY_CONFIDENCE_THRESHOLD
from app.domains.music.analysis_precedence import effective_confidences, listing_analysis, precedence

DATA = Path(__file__).resolve().parents[3] / 'renderer/src/analysis/accuracy-data'


def test_versioned_calibration_integrity_and_server_cutoffs():
    data = json.loads((DATA / 'giantsteps-summary.json').read_text())
    assert data['version'] == 1 and data['measured'] == '2026-11-12'
    assert data['cutoffs']['key'] == KEY_CONFIDENCE_THRESHOLD
    assert data['cutoffs']['bpm'] == BPM_CONFIDENCE_THRESHOLD
    for bands, total in ((data['key']['calibration_exact'], 604),
                         (data['tempo']['v2']['calibration_acc1'], 661),
                         (data['tempo']['v2']['calibration_acc2'], 661)):
        assert len(bands) == 10 and sum(b['n'] for b in bands) == total
        assert [b['decile'] for b in bands] == list(range(1, 11))
        assert [b['conf_min'] for b in bands] == sorted(b['conf_min'] for b in bands)
        for band in bands:
            assert 0 <= band['conf_min'] <= band['conf_max'] <= 1
            assert band['ci95'][0] <= band['pct'] <= band['ci95'][1]
            assert band['pct'] == round(band['hits'] / band['n'] * 100, 1)
    assert [(b['conf_min'], b['conf_max']) for b in data['tempo']['v2']['calibration_acc1']] == [
        (b['conf_min'], b['conf_max']) for b in data['tempo']['v2']['calibration_acc2']]


@pytest.mark.parametrize('source', ['computed', 'tag', 'fixed', 'missing'])
@pytest.mark.parametrize('confidence', [0, 0.004, 0.4, 1, None])
def test_confidence_projection_is_nullable_and_never_borrows_from_a_hidden_value(source, confidence):
    row = {'key': '5A', 'bpm': 123, 'key_conf': confidence, 'bpm_conf': confidence}
    tags = {}
    if source == 'tag':
        tags = {'key': '8B', 'bpm': 126}
    if source == 'fixed':
        row.update(fixed_key='2A', fixed_bpm=130)
    if source == 'missing':
        row.update(key=None, bpm=None)
    effective = precedence(row, tags)
    projected = effective_confidences(row, effective)
    assert projected == {'keyConfidence': confidence if source == 'computed' else None,
                         'bpmConfidence': confidence if source == 'computed' else None}
    listing = listing_analysis(effective, row)
    assert all(listing[k] == v for k, v in projected.items())
