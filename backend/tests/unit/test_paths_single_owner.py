"""Prevent new default-root spellings outside the two distributed resolvers."""
import ast
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
# Exact expressions, with reasons. No whole-file exclusions for consumers.
ALLOW = {
    ('backend/app/domains/system/routes.py', 'Path.home()'): 'Music selection also permits the user home.',
    ('backend/app/providers/secret_settings.py', "'Krobi'"): 'A Genius search query, not a filesystem path.',
    ('helper/krobi_helper/cli.py', 'Path.home()'): 'demucs-mlx owns its external cache location.',
    ('helper/krobi_helper/addons.py', 'Path.home()'): 'Inspect the external demucs-mlx cache for uninstall accounting.',
}


def violations(files):
    found = []
    for relative, content in files:
        if relative in ('backend/app/infra/paths.py', 'helper/krobi_helper/paths.py'):
            continue
        for node in ast.walk(ast.parse(content)):
            home = isinstance(node, ast.Call) and ast.unparse(node.func) == 'Path.home'
            krobi = isinstance(node, ast.Constant) and isinstance(node.value, str) and (node.value == 'Krobi' or node.value.startswith('Krobi/'))
            if (home or krobi) and (relative, ast.unparse(node)) not in ALLOW:
                found.append((relative, node.lineno, ast.unparse(node)))
    return found


def test_paths_have_one_owner():
    files = [(str(p.relative_to(REPO)), p.read_text()) for directory in ('backend/app', 'helper/krobi_helper', 'helper/compat')
             for p in (REPO / directory).rglob('*.py')]
    assert violations(files) == []


def test_guard_rejects_planted_defaults():
    for directory in ('backend/app', 'helper/krobi_helper'):
        assert violations([(f'{directory}/planted.py', 'from pathlib import Path\nROOT = Path.home() / "Krobi"')])
