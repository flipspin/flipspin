import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./check-release-version.mjs', import.meta.url);
const sources = {
  'backend/app/config.py': v => `APP_VERSION = "${v}" # API version\n`,
  'package.json': v => JSON.stringify({ version: v }),
  'src-tauri/tauri.conf.json': v => JSON.stringify({ version: v }),
  // A dependency's version must never substitute for the package version.
  'src-tauri/Cargo.toml': v => `[package]\nname = "krobi"\nversion = "${v}"\n\n[dependencies]\nversion = "9.9.9"\n`,
};

function run(t, { version = '1.2.3', tag = `v${version}`, different, missing } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'krobi-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(sources)) {
    if (file === missing) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content(file === different ? '9.9.9' : version));
  }
  return spawnSync(process.execPath, [script.pathname, tag], { cwd: root, encoding: 'utf8' });
}

test('all four versions equal the tag: pass', t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1.2.3');
});

for (const file of Object.keys(sources)) {
  test(`${file} differs: fail naming the file`, t => {
    const result = run(t, { different: file });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${file}: expected 1.2.3, found 9.9.9`));
  });
  test(`${file} missing: fail naming the file`, t => {
    const result = run(t, { missing: file });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(file));
  });
}

test('matching prerelease versions pass', t => {
  const result = run(t, { version: '1.1.0-rc.1' });
  assert.equal(result.status, 0, result.stderr);
});

for (const tag of ['1.2.3', 'v01.2.3', 'v1.2', 'v1.2.3-01', 'v1.2.3+build', 'v1.2.3-']) {
  test(`invalid release tag ${tag}: fail before builds`, t => {
    assert.equal(run(t, { tag }).status, 1);
  });
}
