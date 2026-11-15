from pathlib import Path

from app.infra.nest_limits import temperature


def test_linux_thermal_zones_use_hottest_readable_value(tmp_path, monkeypatch):
    for index, value in enumerate(('65000', '85000', 'bad', '-1000', 'nan', '0', 'inf')):
        zone = tmp_path / f'thermal_zone{index}'
        zone.mkdir()
        (zone / 'temp').write_text(value)
    assert temperature(tmp_path) == 85
    read = Path.read_text
    def denied(path, *args, **kwargs):
        if path.parent.name == 'thermal_zone1':
            raise PermissionError('sensor unavailable')
        return read(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', denied)
    assert temperature(tmp_path) == 65
    assert temperature(tmp_path / 'absent') is None
