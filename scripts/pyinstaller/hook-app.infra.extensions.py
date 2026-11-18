# Preserve manifests in the standalone backend as well as Python wheels.
from pathlib import Path

# Resolve from the hook, without importing the backend composition root.
app_dir = Path(__file__).resolve().parents[2] / "backend" / "app"
datas = [
    (str(path), str(Path("app") / path.relative_to(app_dir).parent))
    for root in (app_dir / "infra" / "engines",)
    for path in sorted(root.glob("*/krobi-extension.json"))
]
