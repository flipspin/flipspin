"""No destructive actions, false-positive chains, version folding or missing keepers."""
from itertools import combinations

import pytest

from app.domains.music.duplicate_groups import groups


def file(path='a.flac', **values):
    return {'relPath': path, 'title': 'Song', 'artist': 'Artist', 'album': 'Album', 'duration': 180,
            'format': 'FLAC', 'bitrate': 1000, 'plays': 4, 'missing': False,
            'signature': path, 'fingerprint': None, **values}


def test_normalized_artist_title_album_and_exact_duration_boundary():
    result = groups([file('a', artist='Beyoncé', title='Song (2011 Remastered)', album='Álbum'),
                     file('b', artist='beyonce', title='SONG', album='Album', duration=182)], {})
    assert len(result) == 1 and result[0]['basis'] == 'tags'
    for change in ({'album': 'Other'}, {'artist': 'Other'}, {'duration': 182.001}, {'duration': None},
                   {'title': ''}, {'artist': ''}, {'album': ''}):
        assert groups([file('a'), file('b', **change)], {}) == []
    assert len(groups([file('a', artist='Satellites, The'), file('b', artist='The Satellites')], {})) == 1
    assert groups([file('a', artist='AB', title='C'), file('b', artist='A', title='BC')], {}) == []


@pytest.mark.parametrize('version', ['Live', 'Remix', 'Acoustic', 'Radio Edit', 'Instrumental'])
@pytest.mark.parametrize('fingerprint', [None, 'same-audio'])
def test_versions_stay_distinct_even_when_audio_claims_to_match(version, fingerprint):
    assert groups([file('a', fingerprint=fingerprint), file('b', title=f'Song ({version})', fingerprint=fingerprint)], {}) == []


def test_no_duration_or_dismissal_transitive_chains():
    files = [file(str(i), duration=d) for i, d in enumerate([180, 182, 184])]
    result = groups(files, {})
    assert len(result) == 1 and len(result[0]['files']) == 2
    files = [file(str(i)) for i in range(3)]
    result = groups(files, {('0', '2'): {'dismissed': True}})
    assert all({'0', '2'} - {f['relPath'] for f in g['files']} for g in result)


def test_best_format_then_bitrate_differences_and_never_missing():
    files = [file('a', format='MP3', bitrate=320, duration=181, plays=7),
             file('b', bitrate=800), file('c', bitrate=1100, missing=True)]
    group = groups(files, {})[0]
    assert group['keeper'] == 'b'
    copy = next(f for f in group['files'] if f['relPath'] == 'a')
    assert copy['difference'] == {'format': True, 'bitrate': -480, 'duration': 1, 'plays': 3}
    assert groups([file('a', missing=True), file('b', missing=True)], {}) == []
    assert groups([file('a', format='MP3', bitrate=192), file('b', format='MP3', bitrate=320)], {})[0]['keeper'] == 'b'


def test_audio_level_crosses_tags_and_takes_precedence_without_repeating_files():
    files = [file('a', fingerprint='fp'), file('b', title='Spelling', album='Other', fingerprint='fp'), file('c')]
    result = groups(files, {})
    assert len(result) == 1 and result[0]['basis'] == 'audio'
    assert len(result[0]['files']) == 2
    files[1]['duration'] = 183
    assert all(g['basis'] == 'tags' for g in groups(files, {}))


def test_pair_preferences_survive_group_growth_and_cannot_choose_missing():
    prefs = {('a', 'b'): {'keeper': 'a'}}
    files = [file('a', bitrate=200), file('b', bitrate=800)]
    assert groups(files, prefs)[0]['keeper'] == 'a'
    files.append(file('c', bitrate=1200))
    assert groups(files, prefs)[0]['keeper'] == 'a'
    files[0]['missing'] = True
    assert groups(files, prefs)[0]['keeper'] == 'c'
    dismissed = {tuple(sorted((left['relPath'], right['relPath']))): {'dismissed': True} for left, right in combinations(files, 2)}
    assert groups(files, dismissed) == []


def test_group_ids_are_order_independent_root_and_signature_fenced():
    files = [file('a'), file('b')]
    original = groups(files, {}, root='one')[0]['groupId']
    assert groups(files[::-1], {}, root='one')[0]['groupId'] == original
    assert groups(files, {}, root='two')[0]['groupId'] != original
    files[1]['signature'] = 'changed'
    assert groups(files, {}, root='one')[0]['groupId'] != original
