"""Library-relative calm → intense ranking; see docs/analysis.md for the formula."""
from math import isfinite

AROUSAL_RULE_VERSION = 1
AROUSAL_WEIGHTS = {'energy': .5, 'pulse': .3, 'bpm': .2}


def _ranks(values):
    """Percentile midranks in [0, 1], preserving ties and input order."""
    count = len(values)
    if count == 1:
        return [.5]
    ordered = sorted(range(count), key=values.__getitem__)
    ranks = [0.] * count
    start = 0
    while start < count:
        end = start + 1
        while end < count and values[ordered[start]] == values[ordered[end]]:
            end += 1
        rank = (start + end - 1) / (2 * (count - 1))
        for index in ordered[start:end]:
            ranks[index] = rank
        start = end
    return ranks


def library_arousals(rows):
    """Use stored computed cues only; incomplete/invalid and ghost rows get null."""
    valid = [row for row in rows if row['missing_since'] is None and all(
        isinstance(row[field], (int, float)) and isfinite(row[field]) and row[field] >= 0
        for field in AROUSAL_WEIGHTS) and row['bpm'] > 0]
    scores = [0.] * len(valid)
    for field, weight in AROUSAL_WEIGHTS.items():
        ranks = _ranks([row[field] for row in valid])
        scores = [score + weight * rank for score, rank in zip(scores, ranks, strict=True)]
    # Avoid breaking mathematical ties through floating-point addition noise.
    ranks = _ranks([round(score, 12) for score in scores])
    result = dict.fromkeys(row['rel_path'] for row in rows)
    result.update((row['rel_path'], rank) for row, rank in zip(valid, ranks, strict=True))
    return result
