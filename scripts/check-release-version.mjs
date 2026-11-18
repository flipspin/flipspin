import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Build metadata (+...) cannot be represented in a Docker image tag.
const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)';
const releaseTag = new RegExp(`^v(${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?)$`);

export function checkReleaseVersion(tag, root = process.cwd()) {
  const version = releaseTag.exec(tag ?? '')?.[1];
  if (!version) throw new Error('Expected a release tag vX.Y.Z or vX.Y.Z-prerelease (no build metadata)');

  const sources = [
    ['backend/app/config.py', text => text.match(/^APP_VERSION\s*=\s*["']([^"']+)["']/m)?.[1]],
    ['package.json', text => JSON.parse(text).version],
    ['src-tauri/tauri.conf.json', text => JSON.parse(text).version],
    ['src-tauri/Cargo.toml', text => {
      const section = text.split(/^\[package\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0];
      return section?.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1];
    }],
    // The installers name the release in their GitHub User-Agent.
    ['deploy/install.sh', text => text.match(/-A 'Flipspin\/([^ ']+) /)?.[1]],
    ['deploy/krobi', text => text.match(/-A 'Flipspin\/([^ ']+) /)?.[1]],
  ];
  const errors = [];
  for (const [file, parse] of sources) {
    try {
      const actual = parse(readFileSync(resolve(root, file), 'utf8'));
      if (actual !== version) errors.push(`${file}: expected ${version}, found ${actual ?? 'no version'}`);
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(checkReleaseVersion(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
