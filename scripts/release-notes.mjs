import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseNotes(changelog, version, owner, signing) {
  if (!['signed', 'unsigned', 'not-built'].includes(signing)) throw new Error('Missing or invalid macOS signing status');
  if (signing === 'not-built' && !version.includes('-')) throw new Error('Stable releases require a macOS build');
  const sections = new Map();
  let current;
  for (const line of changelog.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      current = line.match(/^## \[([^\]]+)\]/)?.[1];
      if (current) sections.set(current, []);
    }
    // Changelog comparison links belong to the document, not a release section.
    if (current && !/^\[[^\]]+\]:\s/.test(line)) sections.get(current).push(line);
  }
  // A release candidate is described by the version it leads to.
  const base = version.split('-')[0];
  const found = sections.get(version) ?? sections.get(base) ?? sections.get('Unreleased');
  // The release page has its own title; drop the section heading.
  const section = found?.filter(line => !/^##\s/.test(line));
  if (!section) throw new Error(`CHANGELOG.md has neither [${version}] nor [Unreleased]`);
  return `${section.join('\n').trim()}\n\nImage: ghcr.io/${owner.toLowerCase()}/flipspin-server:${version}\n`
    + (signing === 'unsigned' ? '\nThe macOS build is unsigned (not Developer ID signed or notarized).\n' : signing === 'not-built' ? '\nThe macOS installer is built locally and is not included in this prerelease.\n' : '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, owner, signing] = process.argv.slice(2);
  process.stdout.write(releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version, owner, signing));
}
