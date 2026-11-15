"""Pack migration and device failures without models, downloads or real GPUs."""
import json
import os
import subprocess
from importlib import metadata
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from krobi_helper import acceleration, addons, execution, gpu_pack


@pytest.fixture
def portable(monkeypatch):
    monkeypatch.delenv('KROBI_ACCEL', raising=False)
    monkeypatch.setattr(gpu_pack.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(gpu_pack.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(gpu_pack, 'nvidia', lambda: dict(card='NVIDIA test GPU', driver='580.10', available=True, reason=None))
    monkeypatch.setattr(gpu_pack, 'torch_build', lambda: dict(version='2.11.0+cpu', cuda=None, present=True, digest='cpu', files=[]))


def test_cpu_base_never_adopts_a_gpu_pack(portable):
    assert not gpu_pack.status()['installed']
    assert gpu_pack.torch_backend() == 'cpu'
    assert not (addons.models_home() / 'addons.json').exists()


@pytest.mark.parametrize('apple', [False, True])
def test_adopts_installed_build_and_models_without_download(portable, monkeypatch, apple):
    if apple:
        monkeypatch.setattr(gpu_pack.platform, 'system', lambda: 'Darwin')
        monkeypatch.setattr(gpu_pack.platform, 'machine', lambda: 'arm64')
        monkeypatch.setattr(gpu_pack.importlib.util, 'find_spec', lambda _: object())
    monkeypatch.setattr(gpu_pack, 'torch_build', lambda: dict(version='existing', cuda=None if apple else '12.6', present=True, digest='existing-digest', files=['torch/version.py']))
    paths = {'aligner': addons.models_home() / 'aligner', 'demucs': addons.models_home() / 'demucs', 'beats': addons.models_home() / 'beats', 'tempocnn': addons.models_home() / 'tempo'}
    for path in paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'keep')
    monkeypatch.setattr(addons, 'model_paths', lambda: paths)
    monkeypatch.setattr(gpu_pack.subprocess, 'run', lambda *a, **k: pytest.fail('migration must not run an installer'))
    status = gpu_pack.status()
    assert status['installed'] and status['included'] == apple
    data = json.loads((addons.models_home() / 'addons.json').read_text())
    assert all(data[name] for name in addons.REQUIRES)
    assert data['packs'][status['pack']]['adopted']
    assert data['packs'][status['pack']]['version'] == 'existing'
    addons.remove('lyrics')
    assert gpu_pack.status()['installed']
    assert json.loads((addons.models_home() / 'addons.json').read_text())['packs'] == data['packs']


@pytest.mark.parametrize('driver,capability,reason', [('579.9', '8.6', 'driver'), ('580.1', '7.0', 'Turing'), ('580.1', '7.5', None)])
def test_pack_requires_driver_580_and_turing(monkeypatch, driver, capability, reason):
    monkeypatch.setattr(gpu_pack.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout=f'NVIDIA test GPU, {driver}, {capability}\n'))
    result = gpu_pack.nvidia()
    assert result['available'] == (reason is None)
    if reason:
        assert reason in result['reason']


def test_missing_gpu_is_not_offered(monkeypatch):
    def absent(*a, **k):
        raise FileNotFoundError()
    monkeypatch.setattr(gpu_pack.subprocess, 'run', absent)
    assert not gpu_pack.nvidia()['available']


@pytest.mark.parametrize('remove', [False, True])
def test_swap_replaces_torch_and_normalizes_exclusive_ort(portable, monkeypatch, remove):
    builds = iter([dict(version='old', cuda='13.0', present=True), dict(version='new', cuda=None if remove else '13.0', present=True)])
    monkeypatch.setattr(gpu_pack, 'torch_build', lambda: next(builds))
    monkeypatch.setattr(gpu_pack.metadata, 'distribution', lambda _: object())
    commands = []
    monkeypatch.setattr(gpu_pack.subprocess, 'run', lambda argv, **kw: commands.append(argv))
    gpu_pack.change('uv', remove=remove)
    assert commands[0][-1] == 'onnxruntime-gpu' and 'uninstall' in commands[0]
    assert commands[1][-1] == 'onnxruntime>=1.18'
    swap = commands[2]
    assert swap[swap.index('--torch-backend') + 1] == ('cpu' if remove else 'cu130')
    assert not any('onnxruntime-gpu' in command for command in commands[1:])
    record = json.loads((addons.models_home() / 'addons.json').read_text())['packs']['gpu-cuda']
    assert record['enabled'] != remove


def test_failed_swap_does_not_claim_success(portable, monkeypatch):
    monkeypatch.setattr(gpu_pack.metadata, 'distribution', Mock(side_effect=metadata.PackageNotFoundError()))
    monkeypatch.setattr(gpu_pack.subprocess, 'run', Mock(side_effect=subprocess.CalledProcessError(1, 'uv')))
    with pytest.raises(subprocess.CalledProcessError):
        gpu_pack.change('uv')
    assert not (addons.models_home() / 'addons.json').exists()


@pytest.mark.parametrize('accel,error,reason', [('cuda', 'CUDA out of memory', 'oom'), ('cuda', 'CUDA driver error', 'driver'), ('mlx', 'Metal out of memory', 'oom')])
def test_job_retries_once_on_cpu_and_reports_used_device(portable, monkeypatch, tmp_path, accel, error, reason):
    monkeypatch.setattr(acceleration, 'detect', lambda: dict(accel=accel, gpu='test card'))
    calls = []
    def operation():
        calls.append(os.environ['KROBI_ACCEL'])
        if len(calls) == 1:
            raise RuntimeError(error)
        return {'result': 'same output'}
    manifest = tmp_path / 'song.json'
    manifest.write_text('{"worker": {}}')
    result = execution.run(operation, models=('htdemucs',), manifest=manifest)
    assert calls == [accel, 'cpu']
    assert result['accel'] == 'cpu' and result['fallbackReason'] == reason
    assert json.loads(manifest.read_text())['worker']['accel'] == 'cpu'
    assert 'KROBI_ACCEL' not in os.environ


@pytest.mark.parametrize('accel', ['cpu', 'cuda', 'mlx'])
def test_success_reports_device_without_retry(portable, monkeypatch, accel):
    monkeypatch.setattr(acceleration, 'detect', lambda: dict(accel=accel, gpu='test card'))
    operation = Mock(return_value={})
    assert execution.run(operation, models=('mms',))['accel'] == accel
    operation.assert_called_once()


def test_unapproved_models_and_analysis_always_use_cpu(portable, monkeypatch):
    monkeypatch.setattr(acceleration, 'detect', lambda: dict(accel='cuda', gpu='test card'))
    assert execution.run(lambda: {'used': os.environ['KROBI_ACCEL']}, models=('tempocnn',)) == {'used': 'cpu', 'accel': 'cpu', 'gpu': None}


def test_song_error_does_not_retry(portable, monkeypatch):
    monkeypatch.setattr(acceleration, 'detect', lambda: dict(accel='cuda', gpu='test card'))
    operation = Mock(side_effect=RuntimeError('invalid audio'))
    with pytest.raises(RuntimeError, match='invalid audio'):
        execution.run(operation, models=('mms',))
    operation.assert_called_once()


def test_broken_cuda_driver_reports_cpu_before_model_load(portable, monkeypatch):
    monkeypatch.setattr(acceleration, 'detect', lambda: {'accel': 'cpu', 'gpu': None})
    monkeypatch.setattr(gpu_pack, 'torch_build', lambda: {'cuda': '13.0'})
    assert execution.run(lambda: {}, models=('mms',))['fallbackReason'] == 'driver'


def test_second_failure_is_not_retried_again(portable, monkeypatch):
    monkeypatch.setattr(acceleration, 'detect', lambda: {'accel': 'cuda', 'gpu': 'test card'})
    operation = Mock(side_effect=RuntimeError('CUDA out of memory'))
    with pytest.raises(RuntimeError, match='out of memory'):
        execution.run(operation, models=('mms',))
    assert operation.call_count == 2


def test_standalone_align_uses_reported_cpu_retry(portable, monkeypatch, tmp_path, capsys):
    from krobi_helper import cli
    from krobi_helper.kinds.lyrics import align
    import io
    output = io.StringIO()
    monkeypatch.setattr(cli.P, '_PROTOCOL_OUT', output)
    calls = []
    monkeypatch.setattr(acceleration, 'detect', lambda **kw: {'accel': os.environ.get('KROBI_ACCEL', 'cuda'), 'gpu': 'test card'})
    def align_file(*args, **kwargs):
        calls.append(kwargs['device'])
        if len(calls) == 1:
            raise RuntimeError('CUDA out of memory')
        return SimpleNamespace(lines=[SimpleNamespace(conf=.9)], low_lines=[], device='cpu', seconds={},
                               lead_s=0, source='aligned:mms-fa', to_dict=lambda: {'device': 'cpu'})
    monkeypatch.setattr(align, 'align_file', align_file)
    monkeypatch.setattr(align, 'to_lrc', lambda *a, **kw: '[00:01.00] hello')
    text = tmp_path / 'lyrics.txt'
    text.write_text('hello')
    assert cli.main(['align', '--audio', str(tmp_path / 'audio.wav'), '--text', str(text),
                     '--out', str(tmp_path / 'out.lrc'), '--no-isolate', '--json']) == 0
    result = json.loads(output.getvalue().splitlines()[-1])
    assert calls == ['cuda', 'cpu']
    assert result['accel'] == 'cpu' and result['fallbackReason'] == 'oom'
