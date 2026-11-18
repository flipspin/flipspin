"""Lightweight machine facts and child launch policy; no model imports."""
import os
import platform
import subprocess
from datetime import datetime, timedelta
from pathlib import Path


def on_battery():
    try:
        if platform.system() == 'Darwin':
            result = subprocess.run(['pmset', '-g', 'batt'], capture_output=True, text=True, timeout=2, check=False)
            if result.returncode == 0 and 'Battery Power' in result.stdout:
                return True
            if result.returncode == 0 and 'AC Power' in result.stdout and 'InternalBattery' in result.stdout:
                return False
        elif platform.system() == 'Linux':
            for battery in Path('/sys/class/power_supply').glob('*/type'):
                if battery.read_text().strip() == 'Battery':
                    return battery.with_name('status').read_text().strip() == 'Discharging'
        elif platform.system() == 'Windows':
            import ctypes
            class PowerStatus(ctypes.Structure):
                _fields_ = [('ac', ctypes.c_byte), ('flag', ctypes.c_byte), ('percent', ctypes.c_byte),
                            ('reserved', ctypes.c_byte), ('life', ctypes.c_ulong), ('full', ctypes.c_ulong)]
            status = PowerStatus()
            if ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status)) and status.flag not in (128, -1) and status.ac in (0, 1):
                return status.ac == 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


def paused_reason(limits, battery, now=None):
    if limits.get('paused'):
        return 'paused'
    if limits.get('pace') == 'off':
        return 'off'
    if limits.get('onlyCharging') and battery is not False:
        return 'battery'
    window = limits.get('window')
    if window:
        now = now or datetime.now()
        minute, start, end = now.hour * 60 + now.minute, window['startMinute'], window['endMinute']
        days, day = window['days'], now.weekday()
        allowed = (day in days if start == end else day in days and start <= minute < end if start < end else
                   day in days and minute >= start or (now - timedelta(days=1)).weekday() in days and minute < end)
        if not allowed:
            return 'hours'
    return None


def launch_options(argv, limits):
    env = os.environ.copy()
    options = {}
    if limits.get('pace') == 'gentle':
        for key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
            env[key] = '1'
        env['KROBI_HELPER_GENTLE'] = '1'
        if os.name == 'nt':
            options['creationflags'] = subprocess.BELOW_NORMAL_PRIORITY_CLASS
        else:
            argv = ['nice', '-n', '10', *argv]
    return argv, {'env': env, **options}
