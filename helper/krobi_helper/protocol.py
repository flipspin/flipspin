"""Emit additive JSON-line events on stdout; diagnostics belong on stderr.

Unknown events are ignored. Phase strings are translation keys and must remain
stable. See docs/lyrics-align.md for pipeline phases and docs/jobs.md for leases.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Dict

# Captured at import, before `cli` redirects sys.stdout to stderr around the
# libraries: the protocol always reaches the backend even while a job runs.
_PROTOCOL_OUT = sys.stdout

PHASE_DECODING = "decodificando"
PHASE_SEPARATING = "separando"
PHASE_TRANSCRIBING = "transcribiendo"
PHASE_ALIGNING = "alineando"
PHASE_WRITING = "guardando"
# Stems (`krobi-helper stems`; `subiendo` is the agent's upload).
PHASE_RHYTHM = "ritmo"
PHASE_CHOPPING = "cortando"
PHASE_ENCODING = "codificando"
PHASE_UPLOADING = "subiendo"

WHISPER_REPO = "mlx-community/whisper-large-v3-turbo"
DEMUCS_MODEL = "htdemucs"
SOURCE_TRANSCRIBED = "stt:whisper-large-v3-turbo"
SOURCE_ALIGNED = "aligned:mms-fa"

def emit(event: str, **fields: Any) -> None:
    payload: Dict[str, Any] = {"event": event}
    payload.update(fields)
    _PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()
