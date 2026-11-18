import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const n = '(0|[1-9][0-9]*)';
const id = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)';
const semver = new RegExp(`^v?${n}\\.${n}\\.${n}(?:-(${id}(?:\\.${id})*))?$`);
export function parseVersion(value) {
  const match = semver.exec(value);
  if (!match || match[0] !== value) throw new Error(`Invalid release version: ${value}`);
  return { version: value.replace(/^v/, ''), core: match.slice(1, 4).map(BigInt), prerelease: !!match[4] };
}
export function releaseLatest(version, releases) {
  const candidate = parseVersion(version);
  if (!Array.isArray(releases)) throw new Error('Expected a release list');
  let newest = !candidate.prerelease;
  for (const release of releases) {
    if (release.isDraft) continue;
    const tag = release.tagName;
    // Unrelated historic tags do not participate in semver ordering.
    if (!semver.test(tag)) continue;
    const other = parseVersion(tag);
    if (other.version === candidate.version) throw new Error(`Release ${tag} is already published; never reuse a tag`);
    if (release.isPrerelease || other.prerelease) continue;
    const differing = candidate.core.findIndex((part, i) => part !== other.core[i]);
    if (differing === -1 || candidate.core[differing] < other.core[differing]) newest = false;
  }
  return newest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(releaseLatest(process.argv[2], JSON.parse(readFileSync(process.argv[3] ?? 0, 'utf8'))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
