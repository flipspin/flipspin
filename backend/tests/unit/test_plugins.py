"""Trusted plugin discovery, authentication and atomic route registration."""
from concurrent.futures import ThreadPoolExecutor
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.dependencies import DependencyContainer
from app.plugins import load_plugins, plugins_dir


def host(config):
    app = FastAPI()
    app.state.config = config
    app.state.container = DependencyContainer(config)
    return app


def write_plugin(root, name, body):
    package = root / name
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('')
    (package / 'krobi_plugin.py').write_text(body)


def test_missing_directory(config, monkeypatch, tmp_path):
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path / 'absent'))
    app = host(config)
    assert load_plugins(app, []) == []
    assert app.state.plugins == []
    monkeypatch.delenv('KROBI_PLUGINS_DIR')
    assert plugins_dir(config) == config.playlist_dir.parent / 'plugins'


def test_registered_routes_require_host_auth_and_load_once(config, tmp_path, monkeypatch):
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    write_plugin(tmp_path, 'test_plugin_auth', '''from fastapi import APIRouter
router = APIRouter()
@router.get('/api/plugin-test')
def answer(): return {'ok': True}
def register(ctx): ctx.include_router(router)
''')
    def auth(request: Request):
        if request.headers.get('Authorization') != 'Bearer test':
            raise HTTPException(401)
    app = host(config)
    assert load_plugins(app, [Depends(auth)]) == ['test_plugin_auth']
    size = len(app.routes)
    assert load_plugins(app, [Depends(auth)]) == ['test_plugin_auth']
    assert len(app.routes) == size
    client = TestClient(app)
    assert client.get('/api/plugin-test').status_code == 401
    assert client.get('/api/plugin-test', headers={'Authorization': 'Bearer test'}).json() == {'ok': True}


def test_failed_registration_rolls_back_and_continues(config, tmp_path, monkeypatch, caplog):
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    write_plugin(tmp_path, 'test_plugin_a_broken', '''from fastapi import APIRouter
router = APIRouter()
@router.get('/partial')
def answer(): return 'no'
def register(ctx):
    ctx.include_router(router)
    ctx.app.state.partial = True
    raise RuntimeError('broken registration')
''')
    write_plugin(tmp_path, 'test_plugin_z_good', 'def register(ctx): pass\n')
    write_plugin(tmp_path, 'test_plugin_b_good', 'def register(ctx): pass\n')
    write_plugin(tmp_path, 'not-a-package', 'raise RuntimeError("must not load")\n')
    app = host(config)
    assert load_plugins(app, []) == ['test_plugin_b_good', 'test_plugin_z_good']
    assert TestClient(app).get('/partial').status_code == 404
    assert not hasattr(app.state, 'partial')
    assert 'broken registration' in caplog.text


def test_direct_app_route_cannot_bypass_auth(config, tmp_path, monkeypatch):
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    write_plugin(tmp_path, 'test_plugin_direct', '''def register(ctx):
    @ctx.app.get('/unguarded')
    def answer(): return True
''')
    app = host(config)
    assert load_plugins(app, []) == []
    assert TestClient(app).get('/unguarded').status_code == 404


def test_singleton_concurrent_first_requests(config):
    container = DependencyContainer(config)
    made = []
    def factory():
        item = object()
        made.append(item)
        return item
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: container.singleton('plugin', factory), range(40)))
    assert len(made) == 1
    assert all(item is made[0] for item in results)
