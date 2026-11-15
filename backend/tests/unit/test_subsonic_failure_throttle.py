"""Independent guessing buckets cannot be reset by rotating submitted secrets."""
from app.domains.subsonic.failure_throttle import CredentialThrottle


def test_global_window_survives_ip_and_username_churn_and_eviction():
    throttle = CredentialThrottle(burst=30, global_burst=3, max_buckets=2)
    for index in range(3):
        assert not throttle.reject((f'192.0.2.{index}', f'user-{index}'))
    assert throttle.reject(('192.0.2.99', 'new-user'))
    assert len(throttle._buckets) <= 2
    throttle.reset()
    assert not throttle.reject(('192.0.2.99', 'new-user'))


def test_username_normalization_and_independent_ip_bucket():
    throttle = CredentialThrottle(burst=2)
    assert not throttle.reject(('192.0.2.1', ' Listener '))
    assert not throttle.reject(('192.0.2.2', 'LISTENER'))
    assert throttle.reject(('192.0.2.3', 'listener'))
    # Empty/different usernames cannot bypass the same-IP bucket.
    assert not throttle.reject(('192.0.2.1', 'other'))
    assert throttle.reject(('192.0.2.1', ''))
    assert all('listener' not in key for key in throttle._buckets)


def test_windows_expire_without_sleep(monkeypatch):
    import app.domains.subsonic.failure_throttle as module
    now = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: now[0])
    throttle = CredentialThrottle(burst=1, global_burst=1, window_seconds=60)
    assert not throttle.reject(('192.0.2.1', 'listener'))
    assert throttle.reject(('192.0.2.1', 'listener'))
    now[0] += 61
    assert not throttle.reject(('192.0.2.1', 'listener'))
