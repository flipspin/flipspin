"""Trusted, locally installed backend extensions. Plugins run with server privileges."""
from __future__ import annotations

import importlib
import keyword
import logging
import os
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI

from app.config import ConfigManager
from app.dependencies import DependencyContainer
from app.infra.extensions import MANIFEST_NAME, Extension, builtin_engines, read_manifest, source_extensions


@dataclass
class PluginContext:
    app: FastAPI
    container: DependencyContainer
    config: ConfigManager
    auth: list[Any]
    logger: logging.Logger
    _routers: list[APIRouter] = field(default_factory=list, repr=False)

    def include_router(self, router: APIRouter) -> None:
        """Stage a router; the loader applies the host's authentication on commit."""
        self._routers.append(router)


def plugins_dir(config: ConfigManager) -> Path:
    configured = os.getenv("KROBI_PLUGINS_DIR")
    return Path(configured).expanduser() if configured else config.data_root / "plugins"


def load_plugins(app: FastAPI, auth: list[Any]) -> list[str]:
    """Load trusted packages, isolating registration failures from host routes."""
    logger = logging.getLogger(__name__)
    root = plugins_dir(app.state.config)
    loaded = list(getattr(app.state, "plugins", []))
    app.state.plugins = loaded
    extensions = list(getattr(app.state, "plugin_extensions", []))
    app.state.plugin_extensions = extensions
    if not root.is_dir():
        return loaded
    location = str(root.resolve())
    if location not in sys.path:
        sys.path.insert(0, location)
    importlib.invalidate_caches()
    seen = set(getattr(app.state, "plugin_packages", []))
    candidates = []
    for directory in sorted(root.iterdir()):
        name = directory.name
        if (not directory.is_dir() or not name.isidentifier() or keyword.iskeyword(name)
                or name.startswith("_") or name in loaded or name in seen
                or not any((directory / file).is_file() for file in ("krobi_plugin.py", MANIFEST_NAME))):
            continue
        manifest_path = directory / MANIFEST_NAME
        if manifest_path.exists() or manifest_path.is_symlink():
            extension = read_manifest(manifest_path, expected_kind="feature")
            if extension.state == "on" and ("nest" not in extension.runs or
                    not extension.entry.module or extension.entry.module.split(".")[0] != name):
                extension = extension.model_copy(update={"state": "invalid", "reason": "Backend entry must belong to its package and run in nest"})
        else:
            extension = Extension(id=name, kind="feature", name=name, runs=["nest"],
                                  reason="Legacy package without a manifest; supported for one release")
            logger.warning("plugin %s is legacy: no %s; supported for one release", name, MANIFEST_NAME)
        candidates.append((name, directory, extension))
    reserved = builtin_engines() + source_extensions(app.state.config.data_root)
    counts = Counter(item.id for item in reserved + extensions + [item for _, _, item in candidates])
    for name, directory, extension in candidates:
        seen.add(name)
        app.state.plugin_packages = sorted(seen)
        if counts[extension.id] > 1:
            extension.state, extension.reason = "invalid", "Duplicate extension id"
        extensions.append(extension)
        if extension.state != "on":
            logger.warning("plugin %s refused: %s", name, extension.reason)
            continue
        routes = list(app.router.routes)
        state = dict(app.state._state)
        schema = app.openapi_schema
        try:
            module = importlib.import_module(extension.entry.module or f"{name}.krobi_plugin")
            if not Path(module.__file__).resolve().is_relative_to(directory.resolve()):
                raise ImportError(f"plugin package name conflicts with an existing module: {name}")
            ctx = PluginContext(app, app.state.container, app.state.config, auth, logger)
            module.register(ctx)
            # Include on a temporary router first: an invalid later router cannot
            # leave earlier routers installed. Direct app route writes are refused.
            if app.router.routes != routes:
                raise ValueError("plugins must register routes through context.include_router")
            staged = APIRouter()
            for router in ctx._routers:
                staged.include_router(router, dependencies=auth)
            app.include_router(staged)
            app.openapi_schema = None
        except Exception:
            app.router.routes[:] = routes
            app.state._state.clear()
            app.state._state.update(state)
            app.openapi_schema = schema
            extension.state = "failed:registration"
            extension.reason = "Plugin registration failed; see server logs"
            logger.exception("plugin %s failed to register", name)
            continue
        loaded.append(name)
        logger.info("plugin %s registered (%s)", name, directory)
    return loaded
