import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { changedAreas, readAreas, labelerConfig, matchesArea } from './areas.mjs';

const areas = readAreas();
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
function selected(files, options) {
  const changes = changedAreas(areas, files, options);
  const result = Object.entries(ci.jobs).filter(([name, job]) => {
    if (name === 'changes' || name === 'conclusion') return false;
    // Evaluate the actual boolean routing expression against simulated outputs.
    const expression = job.if.replace(/needs\.changes\.outputs\.([a-z]+) == 'true'/g, (_, area) => String(changes[area]));
    assert.match(expression, /^(true|false|\s|\|)+$/);
    return Function(`return ${expression}`)();
  }).map(([name]) => name);
  return [...result, 'conclusion'];
}
test('actual CI gates route docs, contracts, CI, deploy and individual areas', () => {
  for (const file of ['docs/guide.md', 'README.md']) assert.deepEqual(selected([file]), ['docs', 'conclusion']);
  assert.deepEqual(selected(['renderer/AGENTS.md']), ['desktop', 'docs', 'conclusion']);
  assert.deepEqual(selected(['contracts/case.json']), ['backend', 'qa-install', 'desktop', 'shell', 'worker', 'smoke', 'conclusion']);
  const every = ['backend', 'qa-install', 'desktop', 'shell', 'worker', 'smoke', 'docs', 'conclusion'];
  assert.deepEqual(selected(['.github/areas.yml']), every);
  assert.deepEqual(selected(['scripts/check-areas.mjs']), every);
  assert.deepEqual(selected(['resources/icon/krobi-icon.svg']), every);
  assert.deepEqual(selected(['deploy/install.sh']), ['qa-install', 'smoke', 'conclusion']);
  assert.deepEqual(selected(['renderer/src/main.tsx']), ['desktop', 'conclusion']);
  for (const options of [{ eventName: 'workflow_dispatch' }, { eventName: 'pull_request' }, { eventName: 'push', ref: 'refs/heads/main' }, { eventName: 'push', ref: 'refs/tags/v1' }, { eventName: 'push', before: '0'.repeat(40) }]) {
    assert.deepEqual(selected([], options), every);
  }
  assert.equal(matchesArea('docs/nested/file.md', '*.md'), false);
});

test('routing CLI emits all boolean outputs and rejects incomplete diff context', () => {
  const run = spawnSync('node', ['scripts/changes.mjs', '--files', 'contracts/case.json'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^backend=true/m);
  assert.match(run.stdout, /^docs=false/m);
  assert.equal(run.stdout.trim().split('\n').length, 8);
  const invalid = spawnSync('node', ['scripts/changes.mjs'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Missing diff SHAs/);
});

test('conclusion covers every job and its actual shell fails on failures/cancellations', () => {
  const conclusion = ci.jobs.conclusion;
  assert.deepEqual([...conclusion.needs].sort(), Object.keys(ci.jobs).filter(name => name !== 'conclusion').sort());
  assert.equal(conclusion.if, '${{ !cancelled() }}');
  const script = conclusion.steps[0].run;
  for (const [results, expected] of [[['success', 'skipped'], 0], [['success', 'failure'], 1], [['cancelled', 'skipped'], 1]]) {
    const needs = Object.fromEntries(results.map((result, i) => [`job${i}`, { result }]));
    const run = spawnSync('bash', ['-e', '-c', script], { env: { ...process.env, NEEDS: JSON.stringify(needs) }, encoding: 'utf8' });
    assert.equal(run.status, expected, run.stderr);
  }
});

test('toolchain files, smoke isolation and worker fingerprint remain wired', () => {
  for (const job of Object.values(ci.jobs)) for (const step of job.steps ?? []) {
    if (step.uses?.startsWith('actions/setup-python@')) assert.equal(step.with['python-version-file'], '.python-version');
    if (step.uses?.startsWith('actions/setup-node@')) assert.equal(step.with['node-version-file'], '.nvmrc');
  }
  assert.ok(ci.jobs.worker.steps.some(step => step.run === 'node scripts/check-worker-release.cjs'));
  assert.equal(ci.jobs.shell.steps.find(step => step.uses?.startsWith('actions-rust-lang/setup-rust-toolchain@')).with.toolchain, undefined);
});

test('area checker catches dead guide paths, missing guides, uncovered dirs and labeler drift', t => {
  const root = mkdtempSync(join(tmpdir(), 'krobi-areas-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.github'));
  mkdirSync(join(root, 'backend'));
  writeFileSync(join(root, '.github/areas.yml'), 'backend:\n  - backend/**\nci:\n  - .github/**\n');
  writeFileSync(join(root, '.github/AGENTS.md'), '# Automation\n');
  writeFileSync(join(root, 'backend/AGENTS.md'), '# Backend\n');
  writeFileSync(join(root, 'backend/app.py'), '');
  writeFileSync(join(root, 'ARCHITECTURE.md'), '# Architecture\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Root\n');
  writeFileSync(join(root, '.github/labeler.yml'), labelerConfig(readAreas(root)));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  const check = () => spawnSync('node', [new URL('./check-areas.mjs', import.meta.url).pathname], { cwd: root, encoding: 'utf8' });
  assert.equal(check().status, 0);
  writeFileSync(join(root, 'ARCHITECTURE.md'), '`backend/planted-dead.py`\n`https://example.com/nope` `backend/*.py` `backend/{placeholder}` `backend/<name>`\n');
  let run = check();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /missing repo path backend\/planted-dead.py/);
  assert.doesNotMatch(run.stderr, /placeholder|https|<name>|\*\.py/);
  writeFileSync(join(root, 'ARCHITECTURE.md'), '# Architecture\n');
  rmSync(join(root, 'backend/AGENTS.md'));
  run = check();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Code area is missing backend\/AGENTS.md/);
  writeFileSync(join(root, 'backend/AGENTS.md'), '# Backend\n');
  mkdirSync(join(root, 'uncovered'));
  writeFileSync(join(root, 'uncovered/data.json'), '{}');
  execFileSync('git', ['-C', root, 'add', 'uncovered']);
  run = check();
  assert.match(run.stderr, /Uncovered top-level directory: uncovered/);
  execFileSync('git', ['-C', root, 'rm', '--cached', '-r', 'uncovered']);
  writeFileSync(join(root, '.github/labeler.yml'), 'drifted');
  assert.match(check().stderr, /labeler.yml drifted/);
});
