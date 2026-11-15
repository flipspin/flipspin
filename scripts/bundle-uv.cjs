/** Bundle an official, pinned host-native uv, verified BEFORE extraction. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const triples = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
const triple = triples[`${process.platform}-${process.arch}`];
if (!triple) {
  if (process.platform === 'linux') throw new Error(`Unsupported Linux uv architecture: ${process.arch}`);
  console.log('No bundled uv for this build host; skipping.');
  process.exit(0);
}
const VERSION = '0.9.5';
const windows = process.platform === 'win32';
const executable = windows ? 'uv.exe' : 'uv';
const ASSET = `uv-${triple}.${windows ? 'zip' : 'tar.gz'}`;
const base = `https://github.com/astral-sh/uv/releases/download/${VERSION}`;
const target = path.resolve(__dirname, '../src-tauri/resources/backend/bin');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'krobi-uv-'));
try {
  const archive = path.join(staging, ASSET);
  for (const name of [ASSET, `${ASSET}.sha256`]) {
    execFileSync('curl', ['--fail', '--location', '--retry', '3', '--silent', '--show-error', `${base}/${name}`, '-o', path.join(staging, name)]);
  }
  const checksum = fs.readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(checksum) || actual !== checksum) throw new Error('uv release SHA256 mismatch');
  console.log(`SHA256 ${ASSET}: ${actual} OK (official ${VERSION} release checksum)`);
  if (windows) {
    const literal = (value) => `'${value.replace(/'/g, "''")}'`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(staging)}`]);
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', staging]);
  }
  fs.mkdirSync(target, { recursive: true });
  // The Windows ZIP has its binaries at the root; tarballs have a wrapper directory.
  const source = windows ? path.join(staging, executable) : path.join(staging, `uv-${triple}`, executable);
  const binary = path.join(target, executable);
  fs.copyFileSync(source, binary);
  if (!windows) fs.chmodSync(binary, 0o755);
  fs.copyFileSync(path.resolve(__dirname, '../resources/licenses/uv-MIT.txt'), path.join(target, 'uv-LICENSE-MIT.txt'));
  console.log(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim());
  console.log(`SHA256 bin/${executable}: ${createHash('sha256').update(fs.readFileSync(binary)).digest('hex')}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
