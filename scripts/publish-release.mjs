// Two phases allow the workflow to attest the uploaded bytes before promotion.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseVersion, releaseLatest } from './release-latest.mjs';

function command(program, args, allowFailure = false) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`);
  return result;
}
function releases() {
  // gh paginates internally; increase its total limit until the list is complete.
  for (let limit = 100; ; limit *= 2) {
    const items = JSON.parse(command('gh', ['release', 'list', '--limit', String(limit), '--json', 'tagName,isDraft,isPrerelease']).stdout);
    if (items.length < limit) return items;
  }
}
function draft(tag, list, create = false) {
  const result = command('gh', ['release', 'view', tag, '--json', 'isDraft'], true);
  if (result.status === 0) {
    if (JSON.parse(result.stdout).isDraft !== true) throw new Error(`Release ${tag} is already published`);
  } else if (create && !list.some(item => item.tagName === tag)) {
    command('gh', ['release', 'create', tag, '--draft', '--verify-tag', '--title', `Flipspin ${version}`, '--notes-file', notes]);
  } else throw new Error(`Cannot inspect draft ${tag}: ${result.stderr}`);
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []);
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const [phase, statePath = 'release-state.json'] = process.argv.slice(2);
const version = parseVersion(process.env.VERSION).version;
const tag = `v${version}`;
const image = process.env.IMAGE;
const digest = process.env.IMAGE_DIGEST;
const notes = process.env.RELEASE_NOTES;
try {
  if (!/^ghcr\.io\/[a-z0-9._/-]+$/.test(image) || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Expected a GHCR image and multi-arch sha256 digest');
  if (phase === 'prepare') {
    const preparedNotes = { path: resolve(notes), sha256: hash(notes) };
    const source = files('installers');
    const skipMac = process.env.SKIP_MACOS === 'true' && version.includes('-');
    const formats = [...(skipMac ? [] : ['dmg']), 'exe', 'AppImage', 'deb'];
    for (const extension of formats) {
      if (!source.some(path => path.endsWith(`.${extension}`))) throw new Error(`Missing release installer: ${extension}`);
    }
    const wheels = [...(skipMac ? [] : ['macos-15']), 'ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2022'].flatMap(os => {
      const directory = join('keyfinder', `keyfinder-${os}`);
      let paths;
      try { paths = files(directory).filter(path => path.endsWith('.whl')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; paths = []; }
      if (!paths.length) throw new Error(`Missing release wheels: keyfinder-${os}`);
      return paths;
    });
    // The wheels prove the analysis engine built on every platform; installers carry
    // their own copy, so the release page lists only what people download.
    void wheels;
    const assets = source.filter(path => formats.some(extension => path.endsWith(`.${extension}`))).sort();
    const names = assets.map(path => basename(path));
    if (new Set(names).size !== names.length || names.some(name => /[\r\n\\]/.test(name))) throw new Error('Unsafe or duplicate asset filename');
    const list = releases();
    releaseLatest(version, list); // Refuse an equal published version before writes.
    draft(tag, list, true);
    rmSync('release-assets', { recursive: true, force: true });
    mkdirSync('release-assets', { recursive: true });
    const sums = assets.map((path, i) => {
      copyFileSync(path, join('release-assets', names[i]));
      return `${hash(join('release-assets', names[i]))}  ${names[i]}\n`;
    }).join('');
    writeFileSync('release-assets/SHA256SUMS', sums);
    const paths = [...names, 'SHA256SUMS'].map(name => resolve('release-assets', name));
    command('gh', ['release', 'upload', tag, ...paths, '--clobber']);
    writeFileSync(statePath, JSON.stringify({ version, image, digest, notes: preparedNotes, assets: paths.map(path => ({ path, sha256: hash(path) })) }));
  } else if (phase === 'finish') {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.version !== version || state.image !== image || state.digest !== digest || hash(state.notes.path) !== state.notes.sha256 || state.assets.some(asset => hash(asset.path) !== asset.sha256)) throw new Error('Prepared release changed after upload/attestation');
    const list = releases();
    const latest = releaseLatest(version, list);
    draft(tag, list);
    const [major, minor] = version.split('.');
    const tags = [version, `${major}.${minor}`, major];
    if (latest) tags.push('latest');
    command('docker', ['buildx', 'imagetools', 'create', ...tags.flatMap(value => ['--tag', `${image}:${value}`]), `${image}@${digest}`]);
    const flags = ['--draft=false', `--latest=${latest}`];
    flags.push(version.includes('-') ? '--prerelease' : '--prerelease=false');
    command('gh', ['release', 'edit', tag, '--title', `Flipspin ${version}`, '--notes-file', state.notes.path, ...flags]);
    console.log(`Published ${tag} (${digest}, latest=${latest})`);
  } else throw new Error('Usage: publish-release.mjs prepare|finish [state-file]');
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
