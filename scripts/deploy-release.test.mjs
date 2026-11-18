import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const helper = readFileSync(new URL('../deploy/krobi', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Keep stdin as a pipe while only stdout is a terminal, as with curl | sh.
const ttyRunner = `
import errno, os, pty, subprocess, sys
master, slave = pty.openpty()
assert not sys.stdin.isatty()
child = subprocess.Popen(sys.argv[1:], stdin=sys.stdin, stdout=slave, stderr=subprocess.PIPE)
os.close(slave)
output = bytearray()
while True:
    try:
        chunk = os.read(master, 65536)
        if not chunk: break
        output.extend(chunk)
    except OSError as error:
        if error.errno != errno.EIO: raise
        break
os.close(master)
sys.stdout.buffer.write(output.replace(b'\\r\\n', b'\\n'))
sys.stderr.buffer.write(child.stderr.read())
sys.exit(child.wait())
`;
const setupLinkContract = JSON.parse(readFileSync(new URL('../contracts/setup-link.json', import.meta.url), 'utf8'));
function fixture(t, { tag = 'latest', response = '{"tag_name":"v1.4.2"}', unreachable = false, lanIp = '192.168.1.2', port = '8000' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'krobi-deploy-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, 'install'), bin = join(root, 'bin');
  mkdirSync(install); mkdirSync(bin);
  // Deliberately retain the pre-transfer saved image and Compose fallback.
  writeFileSync(join(install, '.env'), `# Managed by krobi installer\nKROBI_IMAGE='ghcr.io/krobi-app/krobi-server'\nKROBI_TAG='${tag}'\nKROBI_PORT='${port}'\nKROBI_MUSIC_DIR='${root}/music'\nKROBI_DATA_DIR='${root}/data'\nPUID='1000'\nPGID='1000'\n`);
  const legacyCompose = 'services:\n  krobi:\n    image: "${KROBI_IMAGE:-ghcr.io/krobi-app/krobi-server}:${KROBI_TAG:-latest}"\n    environment:\n      KROBI_TAG: "${KROBI_TAG:-latest}"\n';
  writeFileSync(join(install, 'compose.yml'), legacyCompose);
  const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const cmd = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify([cmd,...args])+'\\n');
if (cmd === 'id') console.log('0');
if (cmd === 'uname') console.log(args[0] === '-s' ? 'Linux' : 'x86_64');
if (cmd === 'realpath') console.log(path.resolve(args.at(-1)));
if (cmd === 'stat') console.log('1000');
if (cmd === 'ip') console.log(args.includes('route') ? '1.1.1.1 via 192.168.1.1 dev eth0 src '+process.env.LAN_IP : '');
if (cmd === 'curl') {
  if (args.some(a=>a.includes('api.github.com'))) { console.log(process.env.RESPONSE); process.exit(process.env.UNREACHABLE === '1' ? 22 : 0); }
  if (args.some(a=>a.includes('raw.githubusercontent.com'))) {
    if (process.env.HELPER_FAIL === '1') process.exit(22);
    fs.writeFileSync(args[args.indexOf('-o')+1], '#!/bin/sh\\nexit 0\\n');
  } else console.log(JSON.stringify({app:'krobi',version:'1.4.2',isInit:process.env.UNCLAIMED !== '1'}));
}
if (cmd === 'docker' && args[0] === 'compose') {
  const envText = fs.readFileSync(path.join(process.env.INSTALL,'.env'),'utf8');
  const values = Object.fromEntries([...envText.matchAll(/^(\\w+)='([^']*)'$/gm)].map(m=>[m[1],m[2]]));
  const imageTag = values.KROBI_IMAGE_TAG || values.KROBI_TAG || 'latest';
  const marker = values.KROBI_TAG || 'latest';
  fs.appendFileSync(process.env.IMAGES, JSON.stringify({args,image:values.KROBI_IMAGE+':'+imageTag,marker,callerOverride:process.env.KROBI_IMAGE_TAG})+'\\n');
  if (args.includes('images')) console.log('fixture-image');
  if (args.includes('--services')) console.log(process.env.SERVICE_NAME || 'krobi');
}
`;
  for (const name of ['id', 'uname', 'realpath', 'stat', 'ip', 'curl', 'docker']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
  const patched = text => text.replaceAll('/opt/krobi', install).replaceAll('/usr/local/bin/krobi', join(bin, 'krobi')).replaceAll('/usr/local/bin/flipspin', join(bin, 'flipspin'));
  const helperPath = join(root, 'krobi'), installPath = join(root, 'install.sh');
  writeFileSync(helperPath, patched(helper)); writeFileSync(installPath, patched(installer));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: join(root, 'calls'), IMAGES: join(root, 'images'), INSTALL: install,
    RESPONSE: response, UNREACHABLE: unreachable ? '1' : '0', LAN_IP: lanIp, KROBI_TAG: '', KROBI_IMAGE: '', KROBI_IMAGE_TAG: 'caller-override', KROBI_HELPER_REF: '', LC_ALL: 'C.UTF-8', LC_CTYPE: '', LANG: 'C.UTF-8', NO_COLOR: undefined, COLORTERM: '', PYTHONCOERCECLOCALE: '0', PYTHONUTF8: '1' };
  const records = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, install, bin, env, records, run: (kind = 'helper', extra = {}, { tty = false, piped = false } = {}) => {
    const args = kind !== 'install' ? [helperPath, kind === 'helper' ? 'update' : kind] : [installPath, '--yes', '--music', `${root}/music`, '--data', `${root}/data`];
    if (piped) args.splice(0, 1, '-s', '--');
    return spawnSync(tty ? 'python3' : 'sh', tty ? ['-c', ttyRunner, 'sh', ...args] : args, {
      encoding: 'utf8', env: { ...env, ...extra }, timeout: 20000,
      input: piped ? readFileSync(installPath, 'utf8') : '',
    });
  } };
}
for (const tag of ['', 'latest']) test(`follow mode (${tag || 'empty'}) pulls exact release, container remains latest, start remembers it`, t => {
  const f = fixture(t, { tag });
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const calls = f.records('images');
  for (const call of calls.filter(call => call.args.includes('pull') || call.args.includes('up'))) {
    assert.equal(call.image, 'ghcr.io/flipspin/flipspin-server:1.4.2');
    assert.equal(call.marker, 'latest'); assert.equal(call.callerOverride, undefined);
  }
  assert.ok(calls.some(call => call.args.includes('pull'))); assert.ok(calls.some(call => call.args.includes('up')));
  const compose = readFileSync(join(f.install, 'compose.yml'), 'utf8');
  assert.match(compose, /image:.*KROBI_IMAGE_TAG/);
  assert.match(compose, /KROBI_TAG: "\$\{KROBI_TAG:-latest\}"/);
  assert.match(readFileSync(join(f.install, '.env'), 'utf8'), /KROBI_IMAGE_TAG='1.4.2'/);
  const github = f.records('calls').find(call => call[0] === 'curl' && call.some(arg => arg.includes('api.github.com')));
  assert.ok(github.includes('--max-time')); assert.ok(github.includes('--connect-timeout')); assert.ok(github.includes('-A'));
  assert.ok(github.includes('https://api.github.com/repos/flipspin/flipspin/releases/latest'));
  assert.ok(github.includes(`Flipspin/${version} ( https://github.com/flipspin/flipspin )`));
  const start = f.run('start'); assert.equal(start.status, 0, start.stderr);
  const lastUp = f.records('images').filter(call => call.args.includes('up')).at(-1);
  assert.equal(lastUp.image, 'ghcr.io/flipspin/flipspin-server:1.4.2'); assert.equal(lastUp.marker, 'latest');
  assert.equal(f.records('calls').filter(call => call[0] === 'curl' && call.some(arg => arg.includes('api.github.com'))).length, 1);
});
for (const options of [
  { unreachable: true }, { response: '{}' }, { response: '{\"tag_name\":\"v1.4.2\"}\n{\"tag_name\":\"v1.5.0\"}' }, { response: '{"tag_name":"v1.4.2-rc.1"}' },
  { response: '{"tag_name":"v01.4.2"}' }, { response: '{"tag_name":"v1.4.2+build"}' }, { response: '{"tag_name":"main"}' },
]) test(`unavailable or invalid latest (${JSON.stringify(options)}) falls back with one line`, t => {
  const f = fixture(t, options), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim().split('\n').length, 1); assert.match(result.stderr, /using :latest/);
  assert.ok(f.records('images').filter(call => call.args.includes('pull') || call.args.includes('up')).every(call => call.image.endsWith(':latest') && call.marker === 'latest'));
});
test('pinned install never queries GitHub and retains version in image and container', t => {
  const f = fixture(t, { tag: '1.2.3' }), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!f.records('calls').some(call => call.some(arg => arg.includes('api.github.com'))));
  assert.ok(f.records('images').filter(call => call.args.includes('pull') || call.args.includes('up')).every(call => call.image === 'ghcr.io/flipspin/flipspin-server:1.2.3' && call.marker === '1.2.3'));
});
for (const [tag, expected] of [['latest', 'v1.4.2'], ['1.2.3', 'v1.2.3'], ['1.5.0-rc.1', 'v1.5.0-rc.1']]) test(`install ${tag} fetches helper from ${expected} even beside a local helper`, t => {
  const f = fixture(t, { tag });
  writeFileSync(join(f.root, 'krobi'), 'local helper must not be copied');
  const result = f.run('install'); assert.equal(result.status, 0, result.stderr);
  const raw = f.records('calls').find(call => call.some(arg => arg.includes('raw.githubusercontent.com')));
  assert.ok(raw.includes(`https://raw.githubusercontent.com/flipspin/flipspin/${expected}/deploy/krobi`));
  const compose = readFileSync(join(f.install, 'compose.yml'), 'utf8');
  assert.match(compose, /image:.*KROBI_IMAGE_TAG/);
  assert.match(compose, /KROBI_TAG: "\$\{KROBI_TAG:-latest\}"/);
});
test('main helper requires explicit opt-in', t => {
  const f = fixture(t);
  const result = f.run('install', { KROBI_HELPER_REF: 'main' }); assert.equal(result.status, 0, result.stderr);
  assert.ok(f.records('calls').some(call => call.includes('https://raw.githubusercontent.com/flipspin/flipspin/main/deploy/krobi')));
});
test('helper download failure is English and stops installation', t => {
  const f = fixture(t), result = f.run('install', { HELPER_FAIL: '1' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Error: Could not download the release helper/);
});
test('standalone install and helper use the same release resolver', () => {
  const resolver = text => text.slice(text.indexOf('resolve_release()'), text.indexOf('\nfail()'));
  assert.equal(resolver(helper), resolver(installer));
});


test('installer prints the contract setup link and manual inputs only to the terminal', t => {
  const example = setupLinkContract.make[0];
  const address = new URL(example.address);
  const f = fixture(t, { lanIp: address.hostname, port: address.port });
  const token = example.code;
  mkdirSync(join(f.root, 'data', 'Krobi'), { recursive: true });
  writeFileSync(join(f.root, 'data', 'Krobi', 'setup-token'), token, { mode: 0o600 });
  const result = f.run('install', { UNCLAIMED: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Paste it in Flipspin → Setup link/);
  assert.equal(result.stdout.trim().split('\n').slice(-4).join('\n'), `${example.link}\nPaste it in Flipspin → Setup link\nNest address: ${example.address}\nSetup code: ${token}`);
  assert.ok(!result.stderr.includes(token));
  const log = readFileSync(join(f.install, 'install.log'), 'utf8');
  assert.ok(!log.includes(token));
  assert.match(log, /Installation ready\. Log:/);
  const second = f.run('install');
  assert.equal(second.status, 0, second.stderr);
  assert.ok(!second.stdout.includes('Setup code:'));
  assert.ok(!second.stdout.includes('krobi://'));
  assert.ok(second.stdout.endsWith(`\n${example.address}\nAlready set up\n`));
});

test('setup-link reprints the contract using saved configuration without logging credentials', t => {
  const example = setupLinkContract.make[0];
  const address = new URL(example.address);
  const f = fixture(t, { lanIp: address.hostname, port: address.port });
  mkdirSync(join(f.root, 'data', 'Krobi'), { recursive: true });
  writeFileSync(join(f.root, 'data', 'Krobi', 'setup-token'), example.code, { mode: 0o600 });
  const installed = f.run('install', { UNCLAIMED: '1' });
  assert.equal(installed.status, 0, installed.stderr);
  const before = readFileSync(join(f.install, 'install.log'), 'utf8');
  const result = f.run('setup-link', { UNCLAIMED: '1', KROBI_PORT: '9999', KROBI_DATA_DIR: '/ignored' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.endsWith(`\nFlipspin is running · 1.4.2\n\n${example.link}\nPaste it in Flipspin → Setup link\nNest address: ${example.address}\nSetup code: ${example.code}\n`));
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(join(f.install, 'install.log'), 'utf8'), before);
  assert.ok(!before.includes(example.code));
  assert.ok(!JSON.stringify(f.records('calls')).includes(example.code));
});

test('setup-link uses a custom saved host port', t => {
  const f = fixture(t, { port: '8123' });
  const token = setupLinkContract.make[0].code;
  mkdirSync(join(f.root, 'data', 'Krobi'), { recursive: true });
  writeFileSync(join(f.root, 'data', 'Krobi', 'setup-token'), token);
  const result = f.run('setup-link', { UNCLAIMED: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`\nkrobi://192.168.1.2:8123/setup#${token}\n`));
  assert.ok(f.records('calls').some(call => call.includes('http://127.0.0.1:8123/api/status')));
});

test('claimed setup-link exits successfully without reading even a stale setup code', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'data', 'Krobi'), { recursive: true });
  writeFileSync(join(f.root, 'data', 'Krobi', 'setup-token'), setupLinkContract.make[0].code);
  const result = f.run('setup-link');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.endsWith(`\nFlipspin is running · 1.4.2\n\nhttp://${f.env.LAN_IP}:8000\nAlready set up\n`));
  assert.ok(!result.stdout.includes('krobi://'));
  assert.ok(!result.stdout.includes(setupLinkContract.make[0].code));
  assert.ok(!result.stdout.includes('Paste it'));
  assert.ok(!result.stdout.includes('Setup code:'));
  assert.equal(result.stderr, '');
  assert.ok(!existsSync(join(f.install, 'install.log')));
});

test('unclaimed setup-link with no token fails without minting a replacement', t => {
  const f = fixture(t);
  const result = f.run('setup-link', { UNCLAIMED: '1' });
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('krobi://'));
  assert.match(result.stderr, /Could not read the setup code/);
  assert.ok(!existsSync(join(f.root, 'data', 'Krobi', 'setup-token')));
});

test('installer release lookup failure uses English', t => {
  const f = fixture(t, { unreachable: true });
  const result = f.run('install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not check the published release; using :latest\./);
  assert.match(result.stderr, /Could not resolve the release tag/);
});


test('embedded endings and server scene have no drift from deploy/art', () => {
  const result = spawnSync('python3', ['scripts/generate-installer-ending.py', '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const script of [installer, helper]) {
    for (const [delimiter, filename] of [['TRUECOLOR', 'scene.ansi'], ['256', 'scene-256.ansi'], ['PLAIN', 'scene.txt']]) {
      const embedded = script.split(`cat <<'KROBI_SCENE_${delimiter}'\n`)[1].split(`KROBI_SCENE_${delimiter}\n`)[0];
      assert.equal(embedded, readFileSync(new URL(`../deploy/art/${filename}`, import.meta.url), 'utf8'));
    }
  }
});

const endingModes = [
  { name: 'truecolor', tty: true, env: { COLORTERM: 'truecolor' }, art: 'scene.ansi', styled: true },
  { name: '24bit', tty: true, env: { COLORTERM: '24bit' }, art: 'scene.ansi', styled: true },
  { name: '256-colour', tty: true, env: { COLORTERM: '' }, art: 'scene-256.ansi', styled: true },
  { name: 'NO_COLOR', tty: true, env: { COLORTERM: 'truecolor', NO_COLOR: '1' }, art: 'scene.txt', styled: false },
  { name: 'empty-NO_COLOR', tty: true, env: { COLORTERM: 'truecolor', NO_COLOR: '' }, art: 'scene.txt', styled: false },
  { name: 'non-TTY', tty: false, env: { COLORTERM: 'truecolor' }, art: 'scene.txt', styled: false },
  { name: 'non-UTF-8', tty: true, env: { LC_ALL: 'C', COLORTERM: 'truecolor' }, art: null, styled: true },
  { name: 'LC_CTYPE-overrides-LANG', tty: true, env: { LC_ALL: '', LC_CTYPE: 'C' }, art: null, styled: true },
  { name: 'LANG-UTF8', tty: true, env: { LC_ALL: '', LC_CTYPE: '', LANG: 'en_US.utf8' }, art: 'scene-256.ansi', styled: true },
  { name: 'no-locale', tty: false, env: { LC_ALL: '', LC_CTYPE: '', LANG: '' }, art: null, styled: false },
];
for (const kind of ['install', 'setup-link']) for (const mode of endingModes) {
  test(`${kind} ending: ${mode.name} (stdin pipe)`, t => {
    const f = fixture(t, { lanIp: '192.168.1.20' });
    const code = 'fake_setup_code_0123456789';
    mkdirSync(join(f.root, 'data', 'Krobi'), { recursive: true });
    writeFileSync(join(f.root, 'data', 'Krobi', 'setup-token'), code);
    const result = f.run(kind, { UNCLAIMED: '1', ...mode.env }, { tty: mode.tty, piped: kind === 'install' });
    assert.equal(result.status, 0, result.stderr);
    const art = mode.art ? readFileSync(new URL(`../deploy/art/${mode.art}`, import.meta.url), 'utf8') : '';
    const b = mode.styled ? '\x1b[1m' : '', d = mode.styled ? '\x1b[2m' : '', r = mode.styled ? '\x1b[0m' : '';
    const ending = `${art ? '\n' + art : ''}\n${b}Flipspin is running${r} ${d}· 1.4.2${r}\n\n${b}krobi://${f.env.LAN_IP}:8000/setup#${code}${r}\n${d}Paste it in Flipspin → Setup link${r}\n${d}Nest address: http://${f.env.LAN_IP}:8000\nSetup code: ${code}${r}\n`;
    assert.ok(result.stdout.endsWith(ending), result.stdout);
    if (kind === 'setup-link') assert.equal(result.stdout, ending);
    if (!mode.styled) assert.ok(!result.stdout.includes('\x1b'));
    if (!mode.art) assert.ok(!/[⠀░]/u.test(result.stdout));
    if (mode.styled && !mode.art) assert.ok(!/\x1b\[(?:38|48);/.test(result.stdout));
    assert.ok(!result.stderr.includes(code));
    assert.ok(!JSON.stringify(f.records('calls')).includes(code));
    const logPath = join(f.install, 'install.log');
    if (existsSync(logPath)) assert.ok(!readFileSync(logPath, 'utf8').includes(code));
    if (process.env.KROBI_ENDING_CAPTURE_DIR) {
      mkdirSync(process.env.KROBI_ENDING_CAPTURE_DIR, { recursive: true });
      const base = join(process.env.KROBI_ENDING_CAPTURE_DIR, `${kind}-${mode.name}`);
      const captured = result.stdout.slice(-ending.length);
      writeFileSync(`${base}.txt`, captured.replace(/\x1b\[[0-9;]*m/g, ''));
      writeFileSync(`${base}.escaped.txt`, captured.replaceAll('\x1b', '<ESC>'));
    }
  });
}


test('helper addresses new and saved legacy Compose services', t => {
  const f = fixture(t);
  for (const service of ['flipspin', 'krobi']) {
    const result = f.run('logs', { SERVICE_NAME: service });
    assert.equal(result.status, 0, result.stderr);
    const call = f.records('images').filter(call => call.args.includes('logs')).at(-1);
    assert.equal(call.args.at(-1), service);
  }
});
test('new installs provide both command names and the renamed service', t => {
  const f = fixture(t);
  const result = f.run('install');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.bin, 'flipspin')));
  assert.ok(existsSync(join(f.bin, 'krobi')));
  assert.match(readFileSync(join(f.install, 'compose.yml'), 'utf8'), /services:\n  flipspin:/);
});

for (const kind of ['install', 'helper']) for (const tag of ['latest', '1.2.3']) {
  test(`${kind} migrates the saved official image and keeps ${tag} mode`, t => {
    const f = fixture(t, { tag });
    const result = f.run(kind);
    assert.equal(result.status, 0, result.stderr);
    const saved = readFileSync(join(f.install, '.env'), 'utf8');
    assert.match(saved, /^KROBI_IMAGE='ghcr.io\/flipspin\/flipspin-server'$/m);
    assert.ok(saved.includes(`KROBI_TAG='${tag}'`));
    const again = f.run(kind);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(join(f.install, '.env'), 'utf8'), saved);
  });
}
for (const kind of ['install', 'helper']) {
  test(`${kind} preserves a custom server image`, t => {
    const image = 'ghcr.io/example/krobi-server';
    const f = fixture(t, { tag: '1.2.3' });
    const envFile = join(f.install, '.env');
    writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^KROBI_IMAGE=.*$/m, `KROBI_IMAGE='${image}'`));
    const result = f.run(kind);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(join(f.install, '.env'), 'utf8').includes(`KROBI_IMAGE='${image}'`));
  });
}
test('installer User-Agent version agrees with the app release', () => {
  for (const script of [installer, helper]) {
    assert.ok(script.includes(`-A 'Flipspin/${version} ( https://github.com/flipspin/flipspin )'`));
  }
});
