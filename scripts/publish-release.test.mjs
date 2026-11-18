import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const script = new URL('./publish-release.mjs', import.meta.url).pathname;
const formats = ['dmg', 'exe', 'AppImage', 'deb'];
const wheelOS = ['macos-15', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2022'];
function fixture(t, { version = '1.2.3', existing = 'absent', missing, missingWheels, list = [], nested = false, failure = '', skipMac = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'krobi-publish-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), cmd = require('node:path').basename(process.argv[1]);
fs.appendFileSync(process.env.CALLS, JSON.stringify([cmd, ...args])+'\\n');
const state = process.env.STATE;
if (args.slice(0,2).join(' ') === process.env.FAILURE) process.exit(2);
if (cmd === 'docker') process.exit(0);
const mode = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : 'absent';
if (args[1] === 'list') console.log(JSON.stringify(JSON.parse(process.env.RELEASES).slice(0, Number(args[args.indexOf('--limit')+1]))));
if (args[1] === 'view') {
  if (mode === 'absent') process.exit(1);
  console.log(JSON.stringify({isDraft: mode === 'draft'}));
}
if (args[1] === 'create') fs.writeFileSync(state, 'draft');
if (args[1] === 'edit') fs.writeFileSync(state, 'published');
`;
  for (const command of ['gh', 'docker']) writeFileSync(join(root, 'bin', command), fake, { mode: 0o755 });
  writeFileSync(join(root, 'notes.md'), 'release notes, including signing status');
  const state = join(root, 'draft');
  writeFileSync(state, existing);
  for (const extension of formats) {
    if (extension === missing) continue;
    const path = join(root, 'installers', nested ? extension : '', `KROBI ${version}.${extension}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fixture ${extension}`);
  }
  writeFileSync(join(root, 'installers/README.txt'), 'excluded');
  for (const os of wheelOS) {
    if (os === missingWheels) continue;
    const directory = join(root, 'keyfinder', `keyfinder-${os}`);
    mkdirSync(directory, { recursive: true });
    // Multiple Python wheels per OS must all survive preparation.
    for (const python of ['cp310', 'cp312']) {
      writeFileSync(join(directory, `krobi_keyfinder-1.0.0-${python}-${os}.whl`), `fixture ${os} ${python}`);
    }
    writeFileSync(join(directory, 'README.txt'), 'excluded');
  }
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, VERSION: version,
    IMAGE: 'ghcr.io/flipspin/flipspin-server', IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    SKIP_MACOS: String(skipMac), RELEASE_NOTES: join(root, 'notes.md'), CALLS: join(root, 'calls'), STATE: state, RELEASES: JSON.stringify(list), FAILURE: failure };
  return {
    root, env,
    run: phase => spawnSync(process.execPath, [script, phase], { cwd: root, encoding: 'utf8', env }),
    calls: () => existsSync(env.CALLS) ? readFileSync(env.CALLS, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}
for (const nested of [false, true]) test(`fresh publication (${nested ? 'nested' : 'flat'}) has ordered draft/upload/promote/publish`, t => {
  const f = fixture(t, { nested });
  for (const phase of ['prepare', 'finish']) { const r = f.run(phase); assert.equal(r.status, 0, r.stderr); }
  const calls = f.calls();
  const writes = calls.filter(c => c[0] === 'docker' || ['create', 'upload', 'edit'].includes(c[2]));
  assert.deepEqual(writes.map(c => c[0] === 'docker' ? 'promote' : c[2]), ['create', 'upload', 'promote', 'edit']);
  assert.ok(writes[0].includes('--draft')); assert.ok(writes[0].includes('--verify-tag'));
  assert.equal(writes[0][writes[0].indexOf('--title') + 1], 'Flipspin 1.2.3');
  assert.ok(writes[1].includes('--clobber'));
  assert.equal(writes[1].filter(c => formats.some(ext => c.endsWith(`.${ext}`))).length, 4);
  assert.equal(writes[1].filter(c => c.endsWith('.whl')).length, 0);
  assert.ok(writes[1].some(c => c.endsWith('/SHA256SUMS')));
  assert.ok(!writes[1].some(c => c.endsWith('/README.txt')));
  const sums = readFileSync(join(f.root, 'release-assets/SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 4);
  for (const line of sums) {
    const [expected, name] = line.split('  ');
    assert.equal(createHash('sha256').update(readFileSync(join(f.root, 'release-assets', name))).digest('hex'), expected);
    assert.ok(writes[1].includes(join(f.root, 'release-assets', name)));
  }
  assert.ok(writes[2].includes('ghcr.io/flipspin/flipspin-server:latest'));
  assert.ok(writes[3].includes('--latest=true'));
  assert.ok(writes[3].includes('--prerelease=false'));
  assert.ok(writes[3].includes('--notes-file')); // Refresh notes when reusing a draft too.
});
test('rerun after draft upload clobbers assets, never creates twice, publishes once', t => {
  const f = fixture(t);
  for (const phase of ['prepare', 'prepare', 'finish']) { const r = f.run(phase); assert.equal(r.status, 0, r.stderr); }
  assert.equal(f.calls().filter(c => c[2] === 'create').length, 1);
  assert.equal(f.calls().filter(c => c[2] === 'upload' && c.includes('--clobber')).length, 2);
  assert.equal(f.calls().filter(c => c[2] === 'edit').length, 1);
});
test('existing draft is reused without create', t => {
  const f = fixture(t, { existing: 'draft' });
  assert.equal(f.run('prepare').status, 0);
  assert.equal(f.run('finish').status, 0);
  assert.ok(!f.calls().some(c => c[2] === 'create'));
});
test('published release refuses without any writes', t => {
  const f = fixture(t, { existing: 'published' });
  assert.match(f.run('prepare').stderr, /already published/);
  assert.ok(!f.calls().some(c => ['create', 'upload', 'edit'].includes(c[2]) || c[0] === 'docker'));
});
for (const [version, list, prerelease] of [
  ['0.1.0-rc.1', [], true], ['1.3.0-rc.1', [], true], ['1.2.4', [{ tagName: 'v1.3.0', isDraft: false, isPrerelease: false }], false],
]) test(`${version} never changes either latest pointer`, t => {
  const f = fixture(t, { version, list });
  for (const phase of ['prepare', 'finish']) { const r = f.run(phase); assert.equal(r.status, 0, r.stderr); }
  const docker = f.calls().find(c => c[0] === 'docker');
  assert.ok(docker.includes(`ghcr.io/flipspin/flipspin-server:${version}`));
  const [major, minor] = version.split('.');
  assert.ok(docker.includes(`ghcr.io/flipspin/flipspin-server:${major}.${minor}`));
  assert.ok(docker.includes(`ghcr.io/flipspin/flipspin-server:${major}`));
  assert.ok(!docker.some(c => c.endsWith(':latest')));
  const edit = f.calls().find(c => c[2] === 'edit');
  assert.ok(edit.includes('--latest=false')); assert.equal(edit.includes('--prerelease'), prerelease);
});
for (const missing of formats) test(`missing ${missing} fails before gh`, t => {
  const f = fixture(t, { missing });
  assert.match(f.run('prepare').stderr, new RegExp(`Missing release installer: ${missing}`));
  assert.deepEqual(f.calls(), []);
});
for (const missingWheels of wheelOS) test(`missing ${missingWheels} wheels fails before gh`, t => {
  const f = fixture(t, { missingWheels });
  assert.notEqual(f.run('prepare').status, 0);
  assert.match(f.run('prepare').stderr, new RegExp(`Missing release wheels: keyfinder-${missingWheels}`));
  assert.deepEqual(f.calls(), []);
});
test('empty wheel artifact fails before gh', t => {
  const f = fixture(t);
  const directory = join(f.root, 'keyfinder/keyfinder-macos-15');
  rmSync(directory, { recursive: true });
  mkdirSync(directory);
  writeFileSync(join(directory, 'README.txt'), 'no wheels');
  assert.match(f.run('prepare').stderr, /Missing release wheels: keyfinder-macos-15/);
  assert.deepEqual(f.calls(), []);
});
for (const failure of ['release list', 'release upload', 'buildx imagetools']) test(`failure at ${failure} never publishes`, t => {
  const f = fixture(t, { failure });
  const prepare = f.run('prepare');
  if (prepare.status === 0) assert.notEqual(f.run('finish').status, 0);
  assert.ok(!f.calls().some(c => c[2] === 'edit'));
});
test('modified uploaded bytes refuse promotion', t => {
  const f = fixture(t);
  assert.equal(f.run('prepare').status, 0);
  writeFileSync(join(f.root, 'release-assets/SHA256SUMS'), 'changed');
  assert.match(f.run('finish').stderr, /changed after upload/);
  assert.ok(!f.calls().some(c => c[0] === 'docker'));
});

test('a stable version beyond the first page still prevents latest promotion', t => {
  const list = Array.from({ length: 100 }, (_, i) => ({ tagName: `v0.1.${i}`, isDraft: false, isPrerelease: false }));
  list.push({ tagName: 'v1.3.0', isDraft: false, isPrerelease: false });
  const f = fixture(t, { list });
  for (const phase of ['prepare', 'finish']) { const r = f.run(phase); assert.equal(r.status, 0, r.stderr); }
  assert.ok(f.calls().some(c => c.includes('--limit') && c.includes('200')));
  assert.ok(f.calls().find(c => c[2] === 'edit').includes('--latest=false'));
  assert.ok(!f.calls().find(c => c[0] === 'docker').some(c => c.endsWith(':latest')));
});
test('failure after promotion can rerun through the same draft', t => {
  const f = fixture(t, { failure: 'release edit' });
  assert.equal(f.run('prepare').status, 0);
  assert.notEqual(f.run('finish').status, 0);
  assert.equal(readFileSync(f.env.STATE, 'utf8'), 'draft');
  f.env.FAILURE = '';
  for (const phase of ['prepare', 'finish']) { const r = f.run(phase); assert.equal(r.status, 0, r.stderr); }
  assert.equal(f.calls().filter(c => c[2] === 'create').length, 1);
  assert.equal(f.calls().filter(c => c[2] === 'upload' && c.includes('--clobber')).length, 2);
  assert.equal(readFileSync(f.env.STATE, 'utf8'), 'published');
  const writes = f.calls().filter(c => ['create', 'upload', 'edit'].includes(c[2]) || c[0] === 'docker').length;
  assert.match(f.run('prepare').stderr, /already published/);
  assert.equal(f.calls().filter(c => ['create', 'upload', 'edit'].includes(c[2]) || c[0] === 'docker').length, writes);
});

for (const skipMac of [false, true]) test(`prerelease missing Mac assets requires explicit private policy (${skipMac})`, t => {
  const f = fixture(t, { version: '1.2.3-rc.5', skipMac, missing: 'dmg', missingWheels: 'macos-15' });
  const prepared = f.run('prepare');
  if (!skipMac) {
    assert.match(prepared.stderr, /Missing release installer: dmg/);
    assert.deepEqual(f.calls(), []);
    return;
  }
  assert.equal(prepared.status, 0, prepared.stderr);
  const finished = f.run('finish');
  assert.equal(finished.status, 0, finished.stderr);
  const upload = f.calls().find(c => c[2] === 'upload');
  assert.equal(upload.filter(c => c.endsWith('.whl')).length, 0);
  assert.equal(upload.filter(c => formats.some(ext => c.endsWith(`.${ext}`))).length, 3);
});
for (const missing of ['exe', 'AppImage', 'deb']) test(`private prerelease still requires ${missing}`, t => {
  const f = fixture(t, { version: '1.2.3-rc.5', skipMac: true, missing });
  assert.match(f.run('prepare').stderr, new RegExp(`Missing release installer: ${missing}`));
  assert.deepEqual(f.calls(), []);
});
for (const missingWheels of wheelOS.filter(os => os !== 'macos-15')) test(`private prerelease still requires ${missingWheels}`, t => {
  const f = fixture(t, { version: '1.2.3-rc.5', skipMac: true, missingWheels });
  assert.match(f.run('prepare').stderr, new RegExp(`Missing release wheels: keyfinder-${missingWheels}`));
  assert.deepEqual(f.calls(), []);
});
test('stable releases require Mac assets even with the skip flag', t => {
  const f = fixture(t, { skipMac: true, missing: 'dmg' });
  assert.match(f.run('prepare').stderr, /Missing release installer: dmg/);
  assert.deepEqual(f.calls(), []);
});
