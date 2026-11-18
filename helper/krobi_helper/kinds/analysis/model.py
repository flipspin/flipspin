"""Pinned, checksum-verified TempoCNN release artifact."""
import hashlib
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

SHA256 = "36899ddcebd8587ad83cf73e4011e5ce8a1447eb3c5e5c574289d37168f8aa60"
# Release prerequisite: upload the exported artifact at this immutable URL.
URL = "https://github.com/flipspin/flipspin/releases/download/analysis-models-v1/deeptemp-k16-3.onnx"
SOURCE = "https://essentia.upf.edu/models/tempo/tempocnn/deeptemp-k16-3.pb"
NOTICE = f"TempoCNN deeptemp-k16-3 weights and ONNX conversion: AGPL-3.0.\nSource graph: {SOURCE}\nModel source: https://github.com/hendriks73/tempo-cnn\nLicense: https://www.gnu.org/licenses/agpl-3.0.html\n"


def prefetch():
    from ...addons import model_paths

    target = model_paths()["tempocnn"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == SHA256:
        target.with_suffix(".NOTICE.txt").write_text(NOTICE)
        return
    source = os.environ.get("KROBI_TEMPOCNN_URL", URL)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            if Path(source).is_file():
                with open(source, "rb") as local:
                    shutil.copyfileobj(local, stream)
            else:
                with urllib.request.urlopen(source, timeout=120) as response:
                    shutil.copyfileobj(response, stream)
            stream.flush()
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != SHA256:
                raise ValueError("TempoCNN checksum mismatch")
            stream.close()
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    target.with_suffix(".NOTICE.txt").write_text(NOTICE)
