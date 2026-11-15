"""Pure claim policy. Presence/ranking and machine probes are supplied by callers."""
from datetime import datetime, timedelta


def inside_window(window, now):
    if window is None:
        return True
    minute = now.hour * 60 + now.minute
    start, end = window['startMinute'], window['endMinute']
    day = now.weekday()
    if start == end:
        return day in window['days']
    if start < end:
        return day in window['days'] and start <= minute < end
    return (day in window['days'] and minute >= start or
            (now - timedelta(days=1)).weekday() in window['days'] and minute < end)


def decide(policy, limits, worker, row, now: datetime, *, paused_all=False):
    if paused_all or policy['paused'] or limits['paused']:
        return 'paused'
    if limits['pace'] == 'off':
        return 'off'
    if not worker.get('nest') and not inside_window(limits['window'], now):
        return 'hours'
    if limits['onlyCharging'] and worker.get('onBattery') is not False:
        return 'battery'
    if worker.get('pausedReason'):
        return worker['pausedReason']
    if worker.get('nest'):
        if policy['placement'] == 'helpers' or row.get('nest') is False:
            return 'helpers-only'
        if policy['requiredMemoryBytes'] > (worker.get('memoryBytes') or 0):
            return 'memory'
    return None
