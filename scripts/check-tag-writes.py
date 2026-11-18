"""Reject save calls outside the sole tag writer, except known non-tag stores."""
import ast
from pathlib import Path

# These stores save JSON, lyrics or scan records, never audio metadata.
NON_TAG_SAVES = {
    ('providers/registry.py', 'self._store'),
    ('domains/dashboard/services.py', 'self.cache'),
    ('domains/browse/services.py', 'self.cache'),
    ('domains/lyrics/routes.py', 'service'),
    ('domains/lyrics/services.py', 'self'),
    ('domains/music/library_scan.py', 'self.store'),
}


def violations(root):
    problems = []
    for path in sorted(root.rglob('*.py')):
        relative = path.relative_to(root).as_posix()
        if relative == 'domains/metadata/tagwriter.py':
            continue
        tree = ast.parse(path.read_text(encoding='utf-8'), filename=relative)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'save'
                    and (relative, ast.unparse(node.func.value)) not in NON_TAG_SAVES):
                problems.append(f'{relative}:{node.lineno}: save must use the shared tag writer')
    return problems


if __name__ == '__main__':
    problems = violations(Path(__file__).resolve().parents[1] / 'backend/app')
    if problems:
        raise SystemExit('\n'.join(problems))
    print('Tag writes: only the shared writer saves audio metadata.')
