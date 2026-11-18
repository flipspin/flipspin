"""Nest-only limits; no engines or feature policy live here."""
from pathlib import Path

THERMAL_ROOT = Path('/sys/class/thermal')


def temperature(root=None):
    """Linux thermal zones expose millidegrees. Use the hottest readable zone."""
    readings = []
    for sensor in (root or THERMAL_ROOT).glob('thermal_zone*/temp'):
        try:
            value = float(sensor.read_text()) / 1000
            if 0 < value < 200:
                readings.append(value)
        except (OSError, ValueError):
            continue
    return max(readings, default=None)


def validate(cpu, stop, resume):
    if not 1 <= cpu <= 100 or not 40 <= stop <= 100 or not 30 <= resume < stop:
        raise ValueError('invalid nest CPU/temperature limits')
