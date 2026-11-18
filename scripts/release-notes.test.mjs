import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotes } from './release-notes.mjs';

const changelog = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Next.\n\n## [1.2.3] - 2026-11-07\n\n### Fixed\n\n- Shipped.\n\n## [1.2.2]\n\n- Older.\n\n[1.2.2]: https://example.com\n';

test('exact version section, image tag normalized like metadata-action, unsigned notice', () => {
  assert.equal(releaseNotes(changelog, '1.2.3', 'Flipspin', 'unsigned'),
    '### Fixed\n\n- Shipped.\n\nImage: ghcr.io/flipspin/flipspin-server:1.2.3\n\nThe macOS build is unsigned (not Developer ID signed or notarized).\n');
});

test('prerelease without its version section falls back to Unreleased; signed build has no unsigned notice', () => {
  const notes = releaseNotes(changelog, '1.3.0-rc.1', 'owner', 'signed');
  assert.match(notes, /- Next\./);
  assert.match(notes, /Image: ghcr.io\/owner\/flipspin-server:1.3.0-rc.1/);
  assert.ok(!notes.includes('unsigned') && !notes.includes('Shipped.'));
});

test('last section excludes changelog comparison links', () => {
  assert.ok(!releaseNotes(changelog, '1.2.2', 'owner', 'signed').includes('https://example.com'));
});

test('missing section or signing status fails before publication', () => {
  assert.throws(() => releaseNotes('# Empty', '1.2.3', 'owner', 'signed'), /neither/);
  assert.throws(() => releaseNotes(changelog, '1.2.3', 'owner', ''), /signing status/);
});

test('a locally built Mac prerelease reports the absent installer without a signing claim', () => {
  const notes = releaseNotes(changelog, '1.2.3-rc.5', 'owner', 'not-built');
  assert.match(notes, /macOS installer is built locally and is not included/);
  assert.doesNotMatch(notes, /unsigned|notarized/);
  assert.throws(() => releaseNotes(changelog, '1.2.3', 'owner', 'not-built'), /Stable releases require/);
});

test('a release candidate uses its version section without the heading', () => {
  const notes = releaseNotes('## [Unreleased]\n\n## [0.1.0]\n\nFirst release.\n', '0.1.0-rc.18', 'flipspin', 'unsigned');
  assert.match(notes, /^First release\./);
  assert.doesNotMatch(notes, /## \[/);
});
