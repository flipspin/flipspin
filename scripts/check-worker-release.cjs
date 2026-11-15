/** Checked-in release fingerprint: source edits require a VERSION bump. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../helper');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.py') ? [path.join(dir, e.name)] : []).sort();
}
const version = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
const initVersion = fs.readFileSync(path.join(root, 'krobi_helper/__init__.py'), 'utf8').match(/__version__ = "([^"]+)"/)[1];
const compatVersion = fs.readFileSync(path.join(root, 'compat/pyproject.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
if (version !== compatVersion) throw new Error('Compatibility distribution version must agree');
const compatPin = fs.readFileSync(path.join(root, 'compat/pyproject.toml'), 'utf8').match(/krobi-helper==([^"\]]+)/);
if (!compatPin || compatPin[1] !== version) throw new Error('Compatibility distribution must depend on krobi-helper==' + version);
if (version !== initVersion) throw new Error('Worker package and __version__ must agree');
const hash = createHash('sha256');
for (const file of [...files(path.join(root, 'krobi_helper')), ...files(path.join(root, 'compat')), path.join(root, 'pyproject.toml'), path.join(root, 'compat/pyproject.toml')]) hash.update(path.relative(root, file).split(path.sep).join('/')).update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
const current = { version, sha256: hash.digest('hex') };
const serverVersion = fs.readFileSync(path.resolve(root, '../backend/app/domains/helpers/mac_worker.py'), 'utf8').match(/^SHIPPED_WORKER_VERSION = "([^"]+)"/m)?.[1];
if (serverVersion !== version) throw new Error('Server shipped helper version must agree with helper/release.json');
const manifest = path.join(root, 'release.json');
const previous = JSON.parse(fs.readFileSync(manifest, 'utf8'));
if (process.argv.includes('--record')) {
  if (current.sha256 !== previous.sha256 && version.localeCompare(previous.version, 'en', { numeric: true }) <= 0) throw new Error('Bump the worker version before recording changed code');
  fs.writeFileSync(manifest, JSON.stringify(current, null, 2) + '\n');
} else if (JSON.stringify(current) !== JSON.stringify(previous)) {
  throw new Error('Worker source changed: bump BOTH versions, then node scripts/check-worker-release.cjs --record');
}
console.log(`Worker release ${version}: ${current.sha256} OK`);
