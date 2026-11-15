"""Confidence cutoffs separate estimates from confident computed values.

On corrected GiantSteps labels, confident key accuracy is 67% versus 40% for
estimates; confident tempo accuracy within 4% is 94% versus 75%. These cutoffs
leave about a quarter of keys and a third of tempos marked as estimates.
"""
import hashlib

from app.domains.music.analysis_mood import MOOD_RULE_VERSION

BPM_CONFIDENCE_THRESHOLD = 0.4
KEY_CONFIDENCE_THRESHOLD = 0.004

ENGINE = "keyfinder+tempocnn"
ENGINE_VERSION = 2

# Only uncorrected ghosts may be removed, after this many days missing.
MISSING_GRACE_DAYS = 30

# Mood changes also trigger a pass, alongside the startup mood recompute.
WRITEBACK_RULES_VERSION = hashlib.sha256(
    f'{ENGINE}@{ENGINE_VERSION}:{BPM_CONFIDENCE_THRESHOLD}:{KEY_CONFIDENCE_THRESHOLD}:{MOOD_RULE_VERSION}'.encode()
).hexdigest()[:12]
