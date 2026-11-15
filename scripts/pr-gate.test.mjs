import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const text = readFileSync('.github/workflows/pr-gate.yml', 'utf8');
const workflow = parse(text);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const evaluate = new AsyncFunction('github', 'context', 'core', workflow.jobs.agreement.steps[0].with.script);
const complete = '## Agreement\nsmall fix: failing test\n## How it was tested\nnode --test\n## Checklist\n- [x] Done';
async function gate({ body = complete, title = 'ci: Fix area routing', fork = true, labels = ['changelog:fix'], comments = [], state = 'open' } = {}) {
  const calls = { comments: [], closed: [], failures: [] };
  const pr = { number: 42, title, body, state, head: { repo: { full_name: fork ? 'contributor/krobi' : 'flipspin/flipspin' } }, base: { repo: { full_name: 'flipspin/flipspin' } } };
  const github = { rest: {
    pulls: { get: async () => ({ data: pr }), update: async request => calls.closed.push(request) },
    issues: { listComments: 'comments', listLabelsOnIssue: 'labels', createComment: async request => calls.comments.push(request) }
  }, paginate: async endpoint => endpoint === 'comments' ? comments : labels.map(name => ({ name })) };
  await evaluate(github, { repo: { owner: 'flipspin', repo: 'flipspin' }, payload: { pull_request: { number: 42 } } }, { setFailed: reason => calls.failures.push(reason) });
  return calls;
}

test('fork gate closes missing, empty, comments-only and fenced fake headings with one explanatory comment', async () => {
  for (const body of ['', '## Agreement\n\n## How it was tested\nTests pass', '## Agreement\nEvidence\n## How it was tested\n<!-- template -->\n## Checklist\n- [x] Done', '```md\n## Agreement\nfake\n## How it was tested\nfake\n```']) {
    const result = await gate({ body });
    assert.equal(result.closed.length, 1);
    assert.equal(result.comments.length, 1);
    assert.match(result.comments[0].body, /missing content under/);
    assert.match(result.failures[0], /Missing or empty/);
  }
  const repeated = await gate({ body: '', comments: [{ user: { type: 'Bot' }, body: '<!-- krobi-contribution-gate --> previous explanation' }] });
  assert.equal(repeated.comments.length, 0);
  assert.equal(repeated.closed.length, 1);
});

test('complete fork PR passes; non-forks are never closed for template/title/label problems', async () => {
  const result = await gate();
  assert.deepEqual(result, { comments: [], closed: [], failures: [] });
  const local = await gate({ fork: false, body: '', title: 'Wrong title', labels: [] });
  assert.equal(local.closed.length, 0);
  assert.equal(local.comments.length, 0);
  assert.match(local.failures[0], /PR title/);
  assert.match(local.failures[0], /exactly one/);
});

test('title grammar and length fail with reasons without closing', async () => {
  for (const title of ['CI: Fix routing', 'ci: ', `ci: ${'a'.repeat(69)}`, 'ci, unknown: Fix routing', 'ci: Fix\nrouting']) {
    const result = await gate({ title });
    assert.match(result.failures[0], /PR title/);
    assert.equal(result.closed.length, 0);
  }
  for (const title of ['backend, renderer: Fix decoding', 'ci,docs: Fix guides', `ci: ${'a'.repeat(68)}`]) assert.deepEqual((await gate({ title })).failures, []);
});

test('all PRs require exactly one supported changelog label and label corrections retrigger', async () => {
  for (const fork of [true, false]) for (const labels of [[], ['changelog:feature', 'changelog:fix'], ['changelog:unknown'], ['changelog:fix', 'changelog:unknown']]) {
    const result = await gate({ fork, labels });
    assert.match(result.failures[0], /exactly one/);
    assert.equal(result.closed.length, 0);
  }
  for (const label of ['feature', 'fix', 'docs', 'internal']) assert.deepEqual((await gate({ labels: [`changelog:${label}`, 'area:ci'] })).failures, []);
  assert.ok(workflow.on.pull_request_target.types.includes('labeled'));
  assert.ok(workflow.on.pull_request_target.types.includes('unlabeled'));
});

test('privileged workflow uses API only, least job permissions and pinned actions', () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.agreement.permissions, { 'pull-requests': 'write' });
  assert.deepEqual(workflow.jobs.labels.permissions, { contents: 'read', 'pull-requests': 'write' });
  assert.doesNotMatch(text, /uses: actions\/checkout|\$\{\{[^}]*\.(body|title|ref)/);
  for (const match of text.matchAll(/uses: (.+)/g)) assert.match(match[1], /^[\w.-]+\/[\w.-]+@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
  assert.equal(workflow.jobs.labels.steps[0].with['configuration-path'], '.github/labeler.yml');
  assert.equal(workflow.jobs.labels.steps[0].with['sync-labels'], true);
});
