import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseLatest } from './release-latest.mjs';
const published = (tagName, extra = {}) => ({ tagName, isDraft: false, isPrerelease: false, ...extra });
for (const [name, version, list, expected] of [
  ['first release', '0.1.0', [], true],
  ['newest stable', '1.3.0', [published('v1.2.9')], true],
  ['numeric ordering', '1.10.0', [published('v1.9.9')], true],
  ['older-line patch', '1.2.10', [published('v1.3.0')], false],
  ['rc', '1.4.0-rc.1', [], false],
  ['drafts and prereleases ignored', '1.3.0', [published('v9.0.0', { isDraft: true }), published('v8.0.0-rc.1', { isPrerelease: true })], true],
  ['existing draft reusable', '1.3.0', [published('v1.3.0', { isDraft: true })], true],
]) test(name, () => assert.equal(releaseLatest(version, list), expected));
for (const version of ['1.2.3', '1.2.3-rc.1']) {
  test(`equal published ${version} refuses`, () => assert.throws(() => releaseLatest(version, [published(`v${version}`)]), /already published/));
}
for (const version of ['01.2.3', '1.2.3+meta', '1.2', '1.2.3-01', '1.2.3\n']) {
  test(`invalid version ${version}`, () => assert.throws(() => releaseLatest(version, []), /Invalid/));
}
