"""Installed source composition; discovery never installs or executes code."""
import json
import os
import shutil
from pathlib import Path

from app.infra.extensions import MANIFEST_NAME, source_extensions, builtin_engines, discover_extensions
from app.providers.registry import ProviderDescriptor, ProviderKind
from .supervisor import SourceSupervisor
from app.utils.path_safety import resolve_under


def python_path(root):
    return root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def installed_source(root):
    # Operational environment only. Provider credentials stay in the host.
    env = {key: value for key, value in os.environ.items()
           if key in {'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE'}}
    env.update(KROBI_SOURCE_DATA=str(root / 'data'), KROBI_SOURCE_ID=root.name)
    return SourceSupervisor(root / MANIFEST_NAME, env=env, python=python_path(root), cwd=root / 'src')


def register_source(registry, root, config=None):
    from app.providers.adapters import SourceStreamingProvider
    source = installed_source(root)
    if source.state != 'on':
        return source
    from ..provider import DownloadRepository
    options = DownloadRepository(config, None).options if config else lambda: {}
    registry.register(ProviderDescriptor(id=source.id, name=source.manifest.get('name', root.name),
                      kind=ProviderKind.STREAMING, description='', capabilities=('audio', 'download')),
                      SourceStreamingProvider(source, options))
    return source


def recover_installation(root):
    """Roll back an uncommitted rename before discovery can observe it."""
    journal = root / '.transaction.json'
    if not journal.exists():
        return
    record = json.loads(journal.read_text())
    target = resolve_under(root, record['id'])
    work = resolve_under(root / '.staging', record['work'])
    previous, candidate = work / 'previous', work / 'candidate'
    if previous.exists():
        if not (previous / 'data').exists():
            data = (target if target.exists() else candidate) / 'data'
            if data.exists():
                data.rename(previous / 'data')
        shutil.rmtree(target, ignore_errors=True)
        previous.rename(target)
    elif not record.get('hadPrevious', False):
        shutil.rmtree(target, ignore_errors=True)
    journal.unlink()


def reserved_ids(data):
    features = Path(os.environ.get('KROBI_PLUGINS_DIR', str(Path(data) / 'plugins'))).expanduser()
    names = {item.id for item in builtin_engines() + discover_extensions(features, kind='feature')}
    if features.is_dir():
        names.update(path.name for path in features.iterdir() if path.is_dir() and path.name.isidentifier())
    return names


def register_sources(registry, data, config=None):
    recover_installation(Path(data) / "sources")
    reserved = reserved_ids(data)
    for extension in source_extensions(Path(data)):
        # Invalid observations remain visible in /extensions, never executable.
        if extension.state == 'on' and extension.id not in reserved and registry.get(extension.id) is None:
            root = Path(data) / 'sources' / extension.id
            if root.is_dir():
                register_source(registry, root, config)
