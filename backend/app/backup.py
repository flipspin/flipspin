"""Offline recovery: python -m app.backup restore <stamp> [--data DIR]."""
import argparse
import sys
from pathlib import Path
from types import SimpleNamespace

from app.config import REQUIRED_DIRS, STATE_PATHS, env_paths
from app.infra.backup_restore import restore
from app.infra.backups import BackupManager
from app.infra.paths import data_root
from app.infra.env_sources import load_environment


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['restore'])
    parser.add_argument('stamp')
    parser.add_argument('--data', type=Path, help='data directory (default: configured nest)')
    args = parser.parse_args(argv)
    try:
        # Resolve paths only. Constructing the server config migrates secrets
        # and can create instance.json before restore has acquired its lock.
        root = args.data.expanduser().resolve() if args.data else data_root()
        load_environment(root)
        if args.data:
            paths = {field: root / name for field, (_var, name) in
                     {**REQUIRED_DIRS, **STATE_PATHS}.items()}
        else:
            paths = {**env_paths(root, REQUIRED_DIRS), **env_paths(root, STATE_PATHS)}
        config = SimpleNamespace(data_root=root, **paths)
        preserved = restore(BackupManager(config), args.stamp)
    except Exception as error:
        print(f'Restore refused: {error}', file=sys.stderr)
        return 1
    print('Backup restored. Previous state preserved in:')
    for path in preserved:
        print(path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
