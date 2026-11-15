#!/usr/bin/env python3
"""Exercise installation in a disposable Debian container with Docker access.

Require the /krobi-install-test marker and music/data paths visible at the same
locations to the daemon. The container remains available for inspection;
uninstall retains data. Print setup codes only, never owner credentials.
Use --uninstall-only to check fresh disposable subfolders without claiming again.
"""
import argparse
import json
import re
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--container', required=True)
parser.add_argument('--music', required=True)
parser.add_argument('--data', required=True)
parser.add_argument('--image', default='krobi-install-local')
parser.add_argument('--tag', default='latest')
parser.add_argument('--port', default='18080')
parser.add_argument('--uninstall-only', action='store_true')
args = parser.parse_args()


def run(*command, input=None, ok=True):
    result = subprocess.run(
        ['docker', 'exec', '-i', args.container, 'env', 'COMPOSE_ANSI=never', 'COMPOSE_PROGRESS=plain', *command],
        input=input, text=True, capture_output=True, timeout=180,
    )
    if ok and result.returncode:
        raise RuntimeError(f'{command[0]} failed ({result.returncode}): {result.stderr}')
    return result


def show(result):
    print(result.stdout, end='', flush=True)
    if result.stderr:
        print(result.stderr, end='', flush=True)


def get_status():
    result = run('curl', '-fsS', f'http://127.0.0.1:{args.port}/api/status')
    show(result)
    print()
    return json.loads(result.stdout)


run('test', '-f', '/krobi-install-test')
repo = Path(__file__).resolve().parent.parent
for name in ['install.sh', 'krobi']:
    subprocess.run(['docker', 'cp', str(repo / 'deploy' / name), f'{args.container}:/deploy/{name}'], check=True)

install = ['env', f'KROBI_IMAGE={args.image}', f'KROBI_TAG={args.tag}', 'sh', '/deploy/install.sh', '--yes',
           '--music', args.music, '--data', args.data, '--port', args.port]


def verify_uninstall():
    cases = [
        ('existing-audio', True, 'album/track.flac', False),
        ('existing-empty', True, None, False),
        ('created-empty', False, None, False),
        ('created-audio', False, 'album/track.UNKNOWN', False),
        ('created-hidden-file', False, '.library-notes', False),
        ('legacy-empty', True, None, True),
    ]
    for name, preexisting, content, legacy in cases:
        music = str(Path(args.music) / name)
        data = str(Path(args.data) / name)
        run('test', '!', '-e', music)
        run('test', '!', '-e', data)
        if preexisting:
            run('mkdir', '-p', music)
        case_install = [*install, '--music', music, '--data', data]
        run(*case_install)
        expected = f"KROBI_MUSIC_CREATED='{0 if preexisting else 1}'"
        assert expected in run('cat', '/opt/krobi/.env').stdout.splitlines()
        # Rerunning must retain ownership, including for a Krobi-created folder
        # that now exists. Missing metadata must never imply ownership.
        run(*case_install)
        assert expected in run('cat', '/opt/krobi/.env').stdout.splitlines()
        if legacy:
            run('sed', '-i', '/^KROBI_MUSIC_CREATED=/d', '/opt/krobi/.env')
        if content:
            run('mkdir', '-p', str(Path(music, content).parent))
            run('tee', str(Path(music, content)), input='library sentinel\n')
        run('tee', f'{data}/.state-sentinel', input='state sentinel\n')

        if name == 'existing-audio':
            for flags in [(), ('--purge',)]:
                rejected = run('krobi', 'uninstall', *flags, ok=False)
                assert rejected.returncode != 0 and 'terminal' in rejected.stderr
            cancelled = run('script', '-qec', 'krobi uninstall --purge', '/dev/null',
                            input='yes\nno\n', ok=False)
            assert cancelled.returncode != 0 and 'Cancelado.' in cancelled.stdout
            assert run('cat', f'{data}/.state-sentinel').stdout == 'state sentinel\n'
            assert run('cat', str(Path(music, content))).stdout == 'library sentinel\n'
            assert get_status()['isInit'] is False
            print('PASS: no terminal rejected; cancelled purge retains music, data and running service.')
            run('script', '-qec', 'krobi uninstall', '/dev/null', input='yes\n')
            assert run('cat', str(Path(music, content))).stdout == 'library sentinel\n'
            assert run('cat', f'{data}/.state-sentinel').stdout == 'state sentinel\n'
            run('test', '!', '-f', '/opt/krobi/compose.yml')
            print('PASS: plain uninstall retains music and data; Compose configuration removed.')
            run(*case_install)

        result = run('script', '-qec', 'krobi uninstall --purge', '/dev/null', input='yes\nyes\n')
        assert f'ELIMINAR DEFINITIVAMENTE los datos ({data})' in result.stdout
        run('test', '!', '-e', data)
        run('test', '!', '-f', '/opt/krobi/compose.yml')
        run('test', '!', '-f', '/opt/krobi/.env')
        run('test', '!', '-f', '/usr/local/bin/krobi')
        run('test', '-f', '/opt/krobi/install.log')
        if name == 'created-empty':
            run('test', '!', '-e', music)
            assert f'y retirar la carpeta vacía creada por Krobi ({music})' in result.stdout
            print(f'PASS: {name}: ownership survives reinstall; empty music folder removed; data removed.')
        else:
            run('test', '-d', music)
            assert f'Se conserva tu música en {music}' in result.stdout
            if content:
                assert run('cat', str(Path(music, content))).stdout == 'library sentinel\n'
            print(f'PASS: {name}: music retained; data removed; confirmation and retention message verified.')


if args.uninstall_only:
    verify_uninstall()
    raise SystemExit(0)

fresh = run(*install)
show(fresh)
address = re.search(r'^Nest address: (.+)$', fresh.stdout, re.M).group(1)
code = re.search(r'^Setup code: (.+)$', fresh.stdout, re.M).group(1)
assert urlsplit(address).port == int(args.port)
assert not urlsplit(address).query
assert 'Paste it in Krobi → Setup link' in fresh.stdout
assert f'krobi://{urlsplit(address).netloc}/setup#{code}' in fresh.stdout.splitlines()
assert run('cat', f'{args.data}/Krobi/setup-token').stdout.strip() == code
status = get_status()
assert status['isInit'] is False and status['setupTokenRequired'] is True
assert code not in run('cat', '/opt/krobi/install.log').stdout

# Reject bad arguments before starting/reconfiguring anything.
for flags in [('--port', '65536'), ('--music', 'relative'), ('--data', '/'), ('--data', args.music)]:
    rejected = run(*install, *flags, ok=False)
    assert rejected.returncode != 0, flags
print('Invalid port, relative path, system directory and overlapping mounts: rejected.')

# The setup code printed separately must really claim the nest.
claim = run('curl', '-fsS', '-w', '\n%{http_code}', '-H', 'Content-Type: application/json',
            '--data-binary', '@-', f'http://127.0.0.1:{args.port}/api/claim',
            input=json.dumps({'label': 'install regression', 'setupToken': code}))
body, http_status = claim.stdout.rsplit('\n', 1)
claimed = json.loads(body)
assert http_status == '201' and claimed['user']['role'] == 'owner'
assert claimed['token'] and claimed['token'] != code
print(f'POST /api/claim: HTTP {http_status}; role={claimed["user"]["role"]}')
assert get_status()['isInit'] is True

run('tee', f'{args.music}/.install-test', input='music sentinel\n')
before = run('cat', '/opt/krobi/.env').stdout
container_id = run('docker', 'compose', '-p', 'krobi', '-f', '/opt/krobi/compose.yml', 'ps', '-q').stdout
second = run(*install)
show(second)
assert 'Setup code:' not in second.stdout
assert run('cat', '/opt/krobi/.env').stdout == before
assert run('docker', 'compose', '-p', 'krobi', '-f', '/opt/krobi/compose.yml', 'ps', '-q').stdout == container_id
print('Second install: same configuration, same container, address only.')
update = run('krobi', 'update')
show(update)
assert 'ya al día' in update.stdout
run('krobi', 'stop')
show(run('krobi', 'start'))
assert get_status()['isInit'] is True

no_terminal = run('krobi', 'uninstall', ok=False)
assert no_terminal.returncode != 0 and 'terminal' in no_terminal.stderr
# A terminal is required even with --purge, and a cancelled second confirmation
# must leave both mounts and the running service untouched.
purge_cancel = run('script', '-qec', 'krobi uninstall --purge', '/dev/null', input='yes\nno\n', ok=False)
assert purge_cancel.returncode != 0
assert get_status()['isInit'] is True
assert 'ELIMINAR DEFINITIVAMENTE' in purge_cancel.stdout
assert 'Cancelado.' in purge_cancel.stdout
users_before = run('cat', f'{args.data}/Krobi/users.json').stdout
show(run('script', '-qec', 'krobi uninstall', '/dev/null', input='yes\n'))
run('test', '-d', args.music)
assert run('cat', f'{args.music}/.install-test').stdout == 'music sentinel\n'
assert run('cat', f'{args.data}/Krobi/users.json').stdout == users_before
run('test', '!', '-f', '/opt/krobi/compose.yml')
assert code not in run('cat', '/opt/krobi/install.log').stdout
print('Uninstall: music and data retained; setup code absent from install.log.')
verify_uninstall()

# An existing Docker without Compose must be left untouched. The fake records
# every Docker call; anything beyond plugin detection would be a regression.
run('mkdir', '-p', '/tmp/krobi-no-compose')
run('tee', '/tmp/krobi-no-compose/docker', input='#!/bin/sh\nprintf "%s\\n" "$*" >>/tmp/krobi-no-compose/calls\nexit 1\n')
run('chmod', '755', '/tmp/krobi-no-compose/docker')
run('rm', '-f', '/tmp/krobi-no-compose/calls')
missing_compose = run('env', 'PATH=/tmp/krobi-no-compose:/usr/bin:/bin', *install, ok=False)
assert missing_compose.returncode != 0 and 'the Compose plugin is missing' in missing_compose.stderr
assert run('cat', '/tmp/krobi-no-compose/calls').stdout.strip() == 'compose version'
print('Existing Docker without Compose: rejected; only plugin detection was called.')
