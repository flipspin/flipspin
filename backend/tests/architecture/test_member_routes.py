"""Every route that changes something is gated, or is listed here as safe for a member."""
import re

from fastapi.routing import APIRoute

from app.main import app

# Dependencies that admit only an owner, an account, an enrolled helper or a real person.
GATES = {'require_owner', 'require_account_owner', 'require_account', 'require_helper', 'require_real_user'}
READS = {'GET', 'HEAD'}

# Routes a member may call. Each reason names where the member's limit is enforced.
MEMBER_ROUTES = [
    (r'/api/acquisition/requests(/clear|/\{id\}/(cancel|clear|retry))?', 'Adds songs to the caller\'s own library; requests are scoped to their starter.'),
    (r'/api/browse/acquire|/api/library/ownership', 'Acquisition and ownership answers are scoped by LibraryScope.'),
    (r'/api/(buscar|buscar-album-info|buscar-canciones|buscar-cover|search-spotify-tracks)', 'Catalog searches; no state changes.'),
    (r'/api/(download|download-album-song|download-search|download-single-song|download-spotify-playlist|download-youtube-url)', 'Legacy acquisition inputs; linked to the caller\'s library.'),
    (r'/api/downloads/(retry|youtube-search)|/api/fetch-spotify-playlist|/api/import-playlist-url', 'Acquisition helpers scoped to the caller.'),
    (r'/api/jobs/(clear|\{job_id\}/(cancel|clear|retry))', 'jobs/routes.py visible(): a member reaches only jobs they started.'),
    (r'/api/(delete-track|library/move-track|update-tags)', 'The handler refuses members (403) before touching shared files.'),
    (r'/api/lyrics/(\{album\}/\{file\}(/offset)?|align|scan|search|transcribe(/pending|/\{progress_id\}/cancel)?)', 'LibraryScope.allows() limits a member to tracks in their library.'),
    (r'/api/playlists(/\{name\}(/refresh|/tracks)?|/spotify-export/(import|parse|resolve(/\{progress_id\}/cancel)?))?|/api/refresh-playlist/\{name\}', 'Playlists belong to their owner account.'),
    (r'/api/stems/request', 'A stems request is limited to tracks in the caller\'s scope.'),
    (r'/api/uploads/(check|batches(/\{id\}(/files/\{sha\}(/fail)?|/retry|/start|/stop))?)', 'Upload batches belong to the account that started them.'),
    (r'/api/(upload-audio-vlc|upload-selected-vlc)', 'Sends the caller\'s own scoped tracks to a VLC device.'),
    (r'/(claim|login|sign-in-code(/poll)?)', 'Public sign-in routes with their own credentials.'),
    (r'/rest/\{method\}', 'OpenSubsonic API, authenticated by its own app passwords.'),
]


def dependency_names(dependant, seen):
    for dependency in dependant.dependencies:
        if dependency.call:
            seen.add(getattr(dependency.call, '__name__', ''))
        dependency_names(dependency, seen)
    return seen


def routes(router, inherited=frozenset()):
    for route in router.routes:
        if isinstance(route, APIRoute):
            yield route, inherited | dependency_names(route.dependant, set())
        elif original := getattr(route, 'original_router', None):
            names = {getattr(d.dependency, '__name__', '') for d in original.dependencies}
            yield from routes(original, inherited | names)


def ungated_writes():
    for route, names in routes(app):
        # Plugins add their own routes; the host only answers for its own.
        if not route.endpoint.__module__.startswith('app.') or not (route.methods - READS):
            continue
        if not names & GATES:
            yield route.path


def test_every_ungated_write_is_a_listed_member_route():
    unlisted = sorted(path for path in ungated_writes() if not any(re.fullmatch(p, path) for p, _ in MEMBER_ROUTES))
    assert unlisted == [], 'gate these with require_owner (or another gate), or list them with the reason a member may call them'


def test_every_listed_member_route_still_exists():
    paths = set(ungated_writes())
    stale = [pattern for pattern, _ in MEMBER_ROUTES if not any(re.fullmatch(pattern, path) for path in paths)]
    assert stale == []


def test_nest_wide_settings_and_logs_are_owner_only():
    owner_only = {('PUT', '/api/providers/{provider_id}'), ('PUT', '/api/providers/{kind}/order'), ('GET', '/api/logs'),
                  ('POST', '/api/set-basedir'), ('POST', '/api/reset-basedir'), ('POST', '/api/open-file')}
    found = {(method, route.path) for route, names in routes(app) for method in route.methods
             if (method, route.path) in owner_only and 'require_owner' in names}
    assert found == owner_only
