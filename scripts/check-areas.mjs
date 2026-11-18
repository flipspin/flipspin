import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readAreas, labelerConfig } from './areas.mjs';

const areas = readAreas();
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const problems = [];
const globs = Object.values(areas).flat();
const dirs = [...new Set(files.filter(file => file.includes('/')).map(file => file.split('/')[0]))];
for (const dir of dirs) {
  if (!globs.some(glob => glob.startsWith(`${dir}/`))) problems.push(`Uncovered top-level directory: ${dir}`);
  const hasCode = dir === '.github' || files.some(file => file.startsWith(`${dir}/`) && /\.(py|[cm]?js|tsx?|rs|sh|ps1|c|cpp|h|cmake)$/.test(file));
  if (hasCode && globs.some(glob => glob.startsWith(`${dir}/`)) && !existsSync(`${dir}/AGENTS.md`)) {
    problems.push(`Code area is missing ${dir}/AGENTS.md`);
  }
}

// Paths in these guides are repository-relative; code/commands and prose are not paths.
const guides = new Set(['docs/architecture.md', 'AGENTS.md', ...files.filter(file => file.endsWith('/AGENTS.md')),
  ...dirs.map(dir => `${dir}/AGENTS.md`).filter(file => existsSync(file))]);
for (const guide of guides) {
  if (!existsSync(guide)) {
    problems.push(`Missing contributor guide: ${guide}`);
    continue;
  }
  const source = readFileSync(guide, 'utf8').replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    const path = match[1];
    if (/[\s*?[\]{}<>]|:\/\//.test(path) || path.startsWith('/') || path.startsWith('~')) continue;
    const isPath = path.includes('/') || files.includes(path) || /^[\w.-]+\.[a-z][a-z0-9]*$/.test(path);
    if (isPath && !existsSync(path)) problems.push(`${guide}: missing repo path ${path}`);
  }
}
const expected = labelerConfig(areas);
if (process.argv.includes('--write-labeler')) writeFileSync('.github/labeler.yml', expected);
if (!existsSync('.github/labeler.yml') || readFileSync('.github/labeler.yml', 'utf8') !== expected) {
  problems.push('labeler.yml drifted: run node scripts/check-areas.mjs --write-labeler');
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else console.log('Area coverage, contributor guides, repo paths and generated labeler config OK');
