import { readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

export function readAreas(root = process.cwd()) {
  const areas = parse(readFileSync(`${root}/.github/areas.yml`, 'utf8'));
  if (!areas || Object.entries(areas).some(([name, globs]) =>
    !/^[a-z]+$/.test(name) || !Array.isArray(globs) || !globs.length ||
    globs.some(glob => typeof glob !== 'string' || /[?![\]{}]/.test(glob)))) {
    throw new Error('areas.yml must map lowercase areas to lists of simple * or ** globs');
  }
  return areas;
}

// The area manifest uses only * (one path segment) and ** (any depth).
export function matchesArea(path, glob) {
  const pattern = glob.split(/(\*\*|\*)/).map(part =>
    part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${pattern}$`).test(path);
}

export function changedAreas(areas, files, { eventName, ref, before } = {}) {
  // PRs, main, tags and manual runs run every suite; only branch pushes are per area.
  const all = eventName === 'workflow_dispatch' || eventName === 'pull_request' ||
    (eventName === 'push' && (ref === 'refs/heads/main' || ref?.startsWith('refs/tags/'))) ||
    (eventName === 'push' && /^0+$/.test(before ?? ''));
  const result = Object.fromEntries(Object.entries(areas).map(([area, globs]) =>
    [area, all || files.some(file => globs.some(glob => matchesArea(file, glob)))]));
  if (result.ci) for (const area of Object.keys(result)) result[area] = true;
  if (result.contracts) for (const area of ['backend', 'renderer', 'shell', 'helper']) result[area] = true;
  return result;
}

export function labelerConfig(areas) {
  return '# Generated from .github/areas.yml by node scripts/check-areas.mjs --write-labeler\n' +
    stringify(Object.fromEntries(Object.entries(areas).map(([name, globs]) =>
      [`area:${name}`, [{ 'changed-files': [{ 'any-glob-to-any-file': globs }] }]])));
}
