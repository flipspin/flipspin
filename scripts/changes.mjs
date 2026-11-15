import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { changedAreas, readAreas } from './areas.mjs';

const options = { eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF };
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
options.before = event.before;
let files;
if (process.argv[2] === '--files') {
  files = process.argv.slice(3);
} else if (options.eventName === 'workflow_dispatch' || options.eventName === 'pull_request' ||
  (options.eventName === 'push' && (options.ref === 'refs/heads/main' || options.ref?.startsWith('refs/tags/') || /^0+$/.test(event.before ?? '')))) {
  files = [];
} else {
  const pr = event.pull_request;
  const base = pr?.base.sha ?? event.before;
  const head = pr?.head.sha ?? process.env.GITHUB_SHA;
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) throw new Error('Missing diff SHAs');
  // PRs use their merge base; pushes include every commit in the push.
  // Include both sides of renames so moving a file cannot skip its former suite.
  files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', pr ? `${base}...${head}` : base, ...(pr ? [] : [head])], { encoding: 'utf8' }).split('\0').filter(Boolean);
}
const result = changedAreas(readAreas(), files, options);
for (const [area, changed] of Object.entries(result)) {
  const line = `${area}=${changed}\n`;
  process.stdout.write(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
}
