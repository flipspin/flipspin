"""Server link generation follows the shared setup-link contract."""
import json
import re
from pathlib import Path

import pytest

from app.infra.setup_link import make_setup_link


CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "contracts/setup-link.json").read_text())


@pytest.mark.parametrize("case", CONTRACT["make"], ids=lambda case: case["address"])
def test_make_setup_link_contract(case):
    assert re.fullmatch(CONTRACT["codePattern"], case["code"])
    assert make_setup_link(case["address"], case["code"]) == case["link"]
