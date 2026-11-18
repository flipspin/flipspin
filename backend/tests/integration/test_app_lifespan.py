"""Application lifespan starts services and always releases the data lock last."""
from importlib import import_module

import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize('fail_startup', [False, True])
async def test_lifespan_cleans_started_services_and_releases_lock_last(monkeypatch, fail_startup):
    main = import_module('app.main')
    calls = []

    def sync(name):
        def call():
            calls.append(name)
            if fail_startup and name == '_analysis_startup':
                raise RuntimeError('startup fault')
        return call

    def asynchronous(name):
        async def call():
            calls.append(name)
        return call

    for name in (
        '_start_backups', '_stop_backups', '_stop_sources', '_stop_job_maintenance',
        '_playlist_cleanup_startup', '_library_scan_startup', '_library_scan_shutdown',
        '_analysis_startup', '_analysis_shutdown', '_lyrics_startup_pass',
        '_prune_orphan_app_passwords', '_prune_orphan_library_rows',
        '_start_lan_advertisement', '_stop_lan_advertisement', '_start_nest_helper',
        '_stop_nest_helper', '_start_update_check', '_stop_update_check',
    ):
        monkeypatch.setattr(main, name, sync(name))
    for name in ('_start_first_run_claim', '_stop_first_run_claim', '_jobs_startup_sweep', '_stop_change_streams'):
        monkeypatch.setattr(main, name, asynchronous(name))

    async def run():
        async with main.app.router.lifespan_context(main.app):
            calls.append('serving')

    if fail_startup:
        with pytest.raises(RuntimeError, match='startup fault'):
            await run()
        assert 'serving' not in calls and '_library_scan_shutdown' in calls
    else:
        await run()
        assert calls.index('_stop_change_streams') == calls.index('serving') + 1
        assert calls.index('_analysis_shutdown') < calls.index('_library_scan_shutdown')
    assert calls[:3] == ['_start_backups', '_start_first_run_claim', '_jobs_startup_sweep']
    assert calls[-1] == '_stop_backups'
