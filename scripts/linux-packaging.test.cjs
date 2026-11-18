/** Exercise host selection on any OS, without downloads, installs or shared deps. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

function run(script, { platform = 'linux', arch = 'x64', ffmpeg = '/deps/ffmpeg', runnable = true, nonfree = false, bundledUv = true, wheelBuild = true, keyfinderWheel = true, checksumOverride, calls = [] } = {}) {
  const archive = Buffer.from('verified fixture archive');
  const checksum = createHash('sha256').update(archive).digest('hex');
  const record = (name) => (...args) => calls.push([name, ...args]);
  const mockFs = {
    mkdirSync: record('mkdir'),
    rmSync: record('remove'),
    copyFileSync: record('copy'),
    chmodSync: record('chmod'),
    existsSync: (file) => /[\/]bin[\/]uv(?:\.exe)?$/.test(file) ? bundledUv : true,
    readdirSync: (dir) => dir.endsWith("helper-worker") ? ["krobi_helper-0.8.0-py3-none-any.whl", "krobi_lyrics-0.8.0-py3-none-any.whl", "krobi_helper-0.11.0-py3-none-any.whl", "krobi_lyrics-0.11.0-py3-none-any.whl"] : ["krobi_helper-0.11.0-py3-none-any.whl", "krobi_lyrics-0.11.0-py3-none-any.whl", ...(keyfinderWheel ? ["krobi_keyfinder-1.0.0-cp312-cp312-native.whl"] : [])],
    unlinkSync: record("unlink"),
    mkdtempSync: () => '/tmp/packaging-fixture',
    readFileSync: (file) => file.endsWith('.sha256') ? (checksumOverride ?? checksum) : archive,
  };
  const mockChild = {
    spawnSync: (...args) => {
      calls.push(['spawn', ...args]);
      return { status: (args[1]?.[0] === "build" && !wheelBuild) || (args[1]?.[0] === '-c' && !ffmpeg) || (args[0].endsWith('/ffmpeg/ffmpeg') && !runnable) ? 1 : 0, stdout: args[1]?.[0] === '-c' ? ffmpeg : '', stderr: nonfree ? 'not legally redistributable' : '' };
    },
    execFileSync: (...args) => { calls.push(['exec', ...args]); return 'uv 0.9.5'; },
  };
  const stop = {};
  let exitCode;
  const filename = path.join(__dirname, script);
  try {
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      __dirname,
      Buffer,
      console: { log() {}, warn() {}, error() {} },
      process: { platform, arch, argv: [], exit(code) { exitCode = code; throw stop; } },
      require(name) {
        if (['fs', 'node:fs'].includes(name)) return mockFs;
        if (['child_process', 'node:child_process'].includes(name)) return mockChild;
        if (name === './check-worker-release.cjs') return calls.push(['release-check']);
        return require(name);
      },
    }, { filename });
  } catch (error) {
    if (error !== stop) throw error;
  }
  return { calls, exitCode };
}

for (const [platform, arch, triple] of [
  ['linux', 'x64', 'x86_64-unknown-linux-musl'],
  ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
  ['darwin', 'arm64', 'aarch64-apple-darwin'],
]) {
  test(`${platform} ${arch} stages a verified native uv`, () => {
    const { calls } = run('bundle-uv.cjs', { platform, arch });
    const urls = calls.filter(([op, bin]) => op === 'exec' && bin === 'curl').map(([, , args]) => args);
    assert.equal(urls.length, 2);
    assert.ok(urls[0].some((arg) => arg.endsWith(`/uv-${triple}.tar.gz`)));
    assert.ok(urls[1].some((arg) => arg.endsWith(`/uv-${triple}.tar.gz.sha256`)));
    assert.ok(calls.some(([op, source, target]) => op === 'copy' && source.endsWith(`/uv-${triple}/uv`) && target.endsWith('/bin/uv')));
    assert.ok(calls.some(([op, target, mode]) => op === 'chmod' && target.endsWith('/bin/uv') && mode === 0o755));
  });
}

test('Windows x64 stages the pinned verified uv.exe from the ZIP root', () => {
  const { calls, exitCode } = run('bundle-uv.cjs', { platform: 'win32' });
  assert.equal(exitCode, undefined);
  const base = 'https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-pc-windows-msvc.zip';
  const downloads = calls.filter(([op, bin]) => op === 'exec' && bin === 'curl');
  assert.deepEqual(downloads.map(([, , args]) => args.at(-3)), [base, `${base}.sha256`]);
  const extraction = calls.findIndex(([op, bin]) => op === 'exec' && bin === 'powershell.exe');
  assert.ok(extraction > calls.indexOf(downloads[1]));
  assert.ok(calls[extraction][2].includes('-NoProfile'));
  assert.match(calls[extraction][2].at(-1), /Expand-Archive -LiteralPath .*\.zip' -DestinationPath /);
  const copy = calls.findIndex(([op, source, target]) => op === 'copy' && source === '/tmp/packaging-fixture/uv.exe' && target.endsWith('/bin/uv.exe'));
  assert.ok(copy > extraction);
  assert.ok(calls.some(([op, source, target]) => op === 'copy' && source.endsWith('/licenses/uv-MIT.txt') && target.endsWith('/bin/uv-LICENSE-MIT.txt')));
  assert.ok(calls.some(([op, bin, args]) => op === 'exec' && bin.endsWith('/bin/uv.exe') && args[0] === '--version'));
  assert.ok(!calls.some(([op]) => op === 'chmod'));
  assert.ok(calls.some(([op, target]) => op === 'remove' && target === '/tmp/packaging-fixture'));
});

for (const checksumOverride of ['0'.repeat(64), 'invalid checksum']) {
  test(`Windows refuses ${checksumOverride.startsWith('0') ? 'mismatched' : 'malformed'} checksums before extraction`, () => {
    const calls = [];
    assert.throws(() => run('bundle-uv.cjs', { platform: 'win32', checksumOverride, calls }), /uv release SHA256 mismatch/);
    assert.ok(!calls.some(([op, bin]) => op === 'exec' && bin !== 'curl'));
    assert.ok(!calls.some(([op]) => op === 'copy'));
    assert.ok(calls.some(([op, target]) => op === 'remove' && target === '/tmp/packaging-fixture'));
  });
}

for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
  test(`${platform}-${arch} builds and stages a fresh portable wheel with bundled uv`, () => {
    const { calls, exitCode } = run('build-helper.cjs', { platform, arch });
    assert.equal(exitCode, undefined);
    assert.ok(calls.some(([op]) => op === 'release-check'));
    const [, command, args] = calls.find(([op]) => op === 'spawn');
    assert.ok(command.endsWith(platform === 'win32' ? '/bin/uv.exe' : '/bin/uv'));
    assert.equal(args[0], 'build');
    assert.ok(args.includes('--wheel'));
    assert.ok(args.at(-1).endsWith('/helper'));
    assert.ok(calls.some(([op, , args]) => op === 'spawn' && args.at(-1).endsWith('/helper/compat')));
    assert.ok(calls.some(([op, , args]) => op === 'spawn' && args.at(-1).endsWith('/helper/keyfinder')));
    assert.ok(calls.some(([op, source, target]) => op === 'copy' && source.endsWith('/krobi_keyfinder-1.0.0-cp312-cp312-native.whl') && target.endsWith('/helper-worker/krobi_keyfinder-1.0.0-cp312-cp312-native.whl')));
    assert.ok(calls.some(([op, source]) => op === 'copy' && source.endsWith('/krobi_lyrics-0.11.0-py3-none-any.whl')));
    assert.ok(calls.some(([op, source, target]) => op === 'copy' && source.endsWith('/krobi_helper-0.11.0-py3-none-any.whl') && target.endsWith('/helper-worker/krobi_helper-0.11.0-py3-none-any.whl')));
    assert.ok(calls.some(([op, file]) => op === 'unlink' && file.endsWith('krobi_helper-0.8.0-py3-none-any.whl')));
    assert.ok(!calls.some(([op, target]) => op === 'remove' && target.endsWith('/helper-worker')));
    assert.ok(calls.some(([op, target]) => op === 'remove' && target === '/tmp/packaging-fixture'));
  });
}

test('Wheel build uses PATH uv when no bundled binary exists', () => {
  const { calls } = run('build-helper.cjs', { bundledUv: false });
  assert.equal(calls.find(([op]) => op === 'spawn')[1], 'uv');
});

test('Missing native KeyFinder wheel refuses to stage an incomplete offline bundle', () => {
  const calls = [];
  assert.throws(() => run('build-helper.cjs', { keyfinderWheel: false, calls }), /Expected the helper, compatibility and KeyFinder wheels/);
  assert.ok(!calls.some(([op]) => op === 'copy'));
});

test('Wheel build failure refuses to stage an old engine', () => {
  assert.throws(() => run('build-helper.cjs', { wheelBuild: false }), /Could not build the helper/);
});

test('Every desktop build stages the wheel inside the shared Tauri resource mapping', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(conf.build.beforeBuildCommand, 'npm run build:desktop');
  assert.ok(pkg.scripts['build:desktop'].includes('npm run build:helper'));
  assert.equal(conf.bundle.resources['resources/backend/'], 'backend/');
  for (const platform of ['win', 'linux', 'mac']) {
    assert.ok(pkg.scripts[`dist:${platform}`].includes('npm run build:backend'));
    assert.ok(pkg.scripts[`dist:${platform}`].includes('tauri build'));
  }
});

test('Linux stages the sole imageio ffmpeg beside the backend', () => {
  const { calls, exitCode } = run('build-backend.cjs');
  assert.equal(exitCode, 0);
  assert.ok(calls.some(([op, , args]) => op === 'spawn' && args.includes('--additional-hooks-dir')));
  assert.ok(calls.some(([op, , args]) => op === 'spawn' && args[0] === '-c' && args[1].includes('bundled_ffmpeg_path')));
  assert.ok(calls.some(([op, target]) => op === 'remove' && target.endsWith('/backend/bin/ffmpeg')));
  assert.ok(calls.some(([op, source, target]) => op === 'copy' && source === '/deps/ffmpeg' && target.endsWith('/backend/ffmpeg/ffmpeg')));
  assert.ok(calls.some(([op, target, mode]) => op === 'chmod' && target.endsWith('/ffmpeg/ffmpeg') && mode === 0o755));
  assert.ok(calls.some(([op, target, args]) => op === 'spawn' && target.endsWith('/ffmpeg/ffmpeg') && args[0] === '-version'));
});

test('Linux refuses to package without ffmpeg', () => {
  assert.equal(run('build-backend.cjs', { ffmpeg: null }).exitCode, 1);
});

test('Linux refuses an ffmpeg binary that cannot run on the build host', () => {
  assert.equal(run('build-backend.cjs', { runnable: false }).exitCode, 1);
});

test('Linux checks the staged license and refuses nonfree parts', () => {
  const { calls } = run('build-backend.cjs');
  assert.ok(calls.some(([op, target, args]) => op === 'spawn' && target.endsWith('/ffmpeg/ffmpeg') && args[0] === '-L'));
  assert.equal(run('build-backend.cjs', { nonfree: true }).exitCode, 1);
});

test('PyInstaller hook does not embed another ffmpeg binary', () => {
  const hook = fs.readFileSync(path.join(__dirname, 'pyinstaller/hook-imageio_ffmpeg.py'), 'utf8');
  assert.ok(!hook.includes('collect_data_files'));
  assert.ok(hook.includes('imageio_ffmpeg.binaries'));
});
