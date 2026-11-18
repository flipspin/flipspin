# Release process

Versioning and the release checklist for Flipspin.

## Versioning

Use Semantic Versioning: `MAJOR.MINOR.PATCH`, optionally followed by a
prerelease suffix such as `-rc.1`. Release tags are `vX.Y.Z` or
`vX.Y.Z-rc.1`; build metadata (`+...`) is not supported in image tags.

The first public beta uses **0.1.0** and the plain tag **v0.1.0**. Publish it
as a regular release so `releases/latest` and the `:latest` image work; an
`-alpha` tag would be a prerelease and would not move those pointers.

Keep these four version sources equal:

- `backend/app/config.py`: `APP_VERSION` (the nest's reported version).
- `package.json`: `version` (the renderer's build-time version).
- `src-tauri/tauri.conf.json`: `version` (installer names).
- `src-tauri/Cargo.toml`: `[package] version` (the desktop shell).

Use a major bump for breaking changes, minor for new compatible features and
patch for compatible fixes. Keep the root and package version entries in
`package-lock.json` and the `krobi-desktop` entry in `src-tauri/Cargo.lock`
in sync when bumping versions too; the release gate checks the four sources
above.

## Release procedure

1. Update `CHANGELOG.md`: move shipped changes from `[Unreleased]` into a
   `## [X.Y.Z] - YYYY-MM-DD` section, add its comparison link and leave an
   empty `[Unreleased]` section for the next release. Complete the FFmpeg
   source offer and `-L` checks below before tagging; include links to the
   exact corresponding sources in the changelog section used as release notes.
2. Bump every version source (including the installers' User-Agent) and the lockfile entries. Check locally:

   ```sh
   node scripts/check-release-version.mjs vX.Y.Z
   node --test scripts/check-release-version.test.mjs scripts/release-notes.test.mjs scripts/release-workflow.test.mjs
   node --test scripts/linux-packaging.test.cjs
   npm run lint
   npm run typecheck
   ```

3. Commit the changes, then create and push the matching tag:

   ```sh
   git add CHANGELOG.md backend/app/config.py package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
   git commit -m "Release X.Y.Z"
   git tag -a vX.Y.Z -m "Release X.Y.Z"
   git push origin vX.Y.Z
   ```

4. Watch `.github/workflows/release.yml`. The order is deliberate:
   - **versions** checks the tag against all four version sources before building.
   - **image** calls `server-image.yml`: smoke amd64, then push an untagged
     multi-arch index for amd64/arm64 and return its digest. No release tag or
     `:latest` moves during a build.
   - **installers** calls `build.yml` for macOS (arm64 DMG), Windows (NSIS exe),
     and Linux (x86_64 AppImage and deb, Ubuntu 22.04). Release builds use no
     caches. Only the macOS job enters `release` and can read Apple secrets;
     signing status travels with its artifact.
   - **publish**, in environment `release`, needs every build. Approve it when
     prompted. It finds or creates a draft with `--verify-tag`, refuses an
     already published release, requires all four installer formats, generates
     `SHA256SUMS`, and uploads with `--clobber`. It attests the files and image
     digest, then promotes that digest to `:X.Y.Z`, `:X.Y`, and `:X`.
     `:latest` moves only for a stable version greater than every published
     stable release. Finally it publishes with explicit `--latest=true|false`
     and `--prerelease` for `-*`. Notes use the exact changelog section or
     `[Unreleased]` and report macOS signing status.
   - **verify** downloads the published assets, checks every checksum, verifies
     an asset's workflow attestation, then pulls `:X.Y.Z` anonymously and boots
     it to `/api/status`. A failure fails the run loudly; it never unpublishes.

The draft holds the complete record before image promotion and publication.
Nests never see an announcement for an image that does not exist. Publish jobs
are serialized across tags so two versions cannot race to claim latest. One
run per tag executes without canceling a run in progress. A failed build moves
no public release tags. A failure before promotion leaves only a draft; a
failure between promotion and publication is recovered by rerunning the job.
Reruns reuse the draft and replace its uploads, then promote and publish once.
An already published release is refused, including on rerun: tags and assets
are permanent. A broken workflow reruns the tag's original workflow file; fix
it on the branch and ship a new patch version instead of moving the tag.

`flipspin update` in follow mode (saved tag empty or `latest`) resolves
`releases/latest` with a bounded request and pulls exactly `:X.Y.Z`. It records
that image version as `KROBI_IMAGE_TAG`, while the container still receives
`KROBI_TAG=latest`, so its update notice remains unpinned. Existing installer
Compose files are migrated on update. On API/network/invalid-tag errors it
prints one Spanish fallback line and uses `:latest`. A saved version retains
its pin. The installer fetches the helper from `vX.Y.Z/deploy/krobi` at that
same release, including when run from a checkout. A fresh installation needs
a resolved release tag to fetch its helper; if the API is unavailable, pass
`KROBI_TAG=X.Y.Z` or retry. `KROBI_HELPER_REF=main` explicitly opts into the
helper on `main` for development. Keep that setting out of production installs.

Manual `build.yml` and `server-image.yml` runs do not create releases. Manual
images get only `:sha-<full-sha>`, never version aliases or `:latest`.

## Settings before the first public tag

The maintainer must configure these when the public repository is created;
the workflow cannot establish these protections:

- A tag ruleset targeting `refs/tags/v*` (the UI pattern is `v*`), restricting
  **creation, update and deletion** to the maintainer via its bypass list.
  Do not grant a build job permission to move tags.
- An environment named **release** with a required reviewer and selected
  deployment **tag** pattern `v*`. Store all Apple secrets there. The macOS
  signing job and the publish job both use this environment and may each
  require review. Configure permitted reviewers without allowing accidental
  self-approval bypasses. `GITHUB_TOKEN` write permissions are granted only
  on the image/publish jobs; no separate long-lived write token is needed.
- **Immutable releases enabled before the first public release.** It applies
  only to subsequently published releases; attach everything while draft.
- The GHCR `flipspin-server` package set to **Public** after its first push,
  before publishing. First pushes default to private. The anonymous verify
  job catches an overlooked setting.

### Order on the day the repository goes public

Each step depends on the one before it; skipping ahead leaves the install line broken:

1. Make `flipspin/flipspin` public. Until then `install.sh` answers 404.
2. Push the final `vX.Y.Z` tag. The installer accepts only a stable tag from
   `releases/latest`, and `:latest` is applied only to final releases, so
   release candidates never satisfy the README's install line or Compose file.
3. Set the GHCR `flipspin-server` package to **Public** while the release is a draft.
4. Re-run the anonymous `verify` job until it passes.
5. On a clean Debian VM, run the README's one-line install, claim the server
   from the desktop app, and install the YouTube source from Settings → Plugins.

All external action references are pinned to full commit SHAs with version
comments; weekly GitHub Actions Dependabot updates keep those pins reviewable.

## Verify a download

Download every installer named by the checksum file and the checksum file:

```sh
gh release download vX.Y.Z --repo flipspin/flipspin --dir krobi-downloads
cd krobi-downloads
sha256sum -c SHA256SUMS
gh attestation verify ./Flipspin_X.Y.Z_aarch64.dmg --repo flipspin/flipspin \
  --signer-workflow flipspin/flipspin/.github/workflows/release.yml
```

Use the actual asset filename from that release for attestation verification.
The checksum detects corruption; the attestation binds those bytes to this
repository's release workflow. The workflow also attests the image index digest.

## Withdraw a bad release (contract action 6)

Never delete, move, or reuse the tag; never replace published assets or the
version image tags. Choose the previous good stable version, verify its digest
and assets, and record the withdrawal in the bad version's CHANGELOG section
and release notes. Mark the bad release prerelease/not-latest, and explicitly
restore the good release and the image `:latest` pointer:

```sh
gh release edit vBAD --repo flipspin/flipspin --prerelease --latest=false
# Authenticate to GHCR as the maintainer before this command. GOOD_DIGEST is
# the verified multi-arch index digest from the previous good release run.
docker buildx imagetools create \
  --tag ghcr.io/flipspin/flipspin-server:latest \
  ghcr.io/flipspin/flipspin-server@sha256:GOOD_DIGEST
gh release edit vGOOD --repo flipspin/flipspin --latest=true
```

Publish a fixed patch with a new tag. Nests drop the bad notice on their next
check (normally daily); nests already updated retain that version until they
update to the fixed patch. A failed verify job calls for this manual decision;
it never withdraws automatically. Rehearse draft rerun recovery and withdrawal
with a later prerelease such as `v0.2.0-rc.1` on the public repository before
the first stable release.
An rc must never take either latest pointer; during its withdrawal rehearsal,
record the previous stable pointers and confirm they remain unchanged (or
that neither exists yet).

## Optional macOS signing

The intended distribution is a Developer ID signed and Apple-notarized DMG,
not the Mac App Store. Until signing credentials are set up, CI also permits
unsigned builds and explicitly labels them in the release body. This does
not provide a trusted Developer ID identity or notarization; users may need
to allow the app in macOS Privacy & Security.

Configure all six `release` environment secrets to enable signing:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the exported certificate |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application signing identity |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_API_KEY` | App Store Connect key ID |
| `APPLE_API_KEY_PATH` | **Contents** of the downloaded `.p8` private key, not a file path |

The macOS job imports the certificate into a temporary keychain and writes
the private key to a restricted temporary file. It passes that file's path
as Tauri v2's `APPLE_API_KEY_PATH`, together with `APPLE_SIGNING_IDENTITY`,
`APPLE_API_ISSUER` and `APPLE_API_KEY`, then removes the temporary credentials
on exit. Secrets are never printed. With any secret absent it builds unsigned;
with a complete secret set, a signing/notarization error fails the job rather
than silently publishing an unsigned replacement. Signing status travels with
the actual macOS build artifact, not a matrix job output.

See [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/)
and [PACKAGING.md](./PACKAGING.md#macos-distribution-policy).

## Installer smoke checks

Use the manual build workflow to prepare candidate installers and test them
before tagging. Install or run the app and verify library, playback, queue,
settings, mini-player, remote login and clean backend shutdown. On a clean
Ubuntu 22.04 desktop, test both AppImage and deb, including MP3/FLAC playback
and seeking and native directory selection. Confirm the Mac lyrics engine
is unavailable on Linux; generated lyrics/stems require an Apple Silicon Mac
on the nest. Build success alone does not prove GUI playback. For signed macOS
candidates, also perform the signing/notarization checks in
[PACKAGING.md](./PACKAGING.md#outputs-and-release-checks).

## Distributing a build

Every installer carries one static FFmpeg binary built with GPL components
(`--enable-gpl`, statically linking x264, x265 and others), so each public
release must include, or offer in writing, the complete corresponding source
for the exact FFmpeg builds it ships:

| Binary | Where it comes from | FFmpeg version | Upstream source |
|---|---|---|---|
| `resources/backend/ffmpeg/ffmpeg` (`ffmpeg.exe` on Windows; the fallback for every consumer) | PyPI `imageio-ffmpeg` 0.6.0 | 7.1 (7.0.2 on Linux arm64) | <https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz>, <https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz> |

Check the version with `<binary> -version` before each release (the
`configuration:` line lists the enabled libraries whose sources belong in the
offer too), attach or link those tarballs from the release page, and keep them
available for as long as the release is.

⚠ Run `<binary> -L` as well. A build that prints *"This version of ffmpeg has
nonfree parts compiled in. Therefore it is not legally redistributable."* must
not ship at all. `build-backend.cjs` probes the staged imageio binary with
`-version` and `-L` and refuses nonfree builds. Its PyInstaller hook excludes
the embedded copy, so only this staged binary ships.

At runtime every consumer uses `resolve_ffmpeg()`: a runnable
`KROBI_FFMPEG_PATH`, then installed ffmpeg (PATH and macOS Homebrew locations),
then this bundled fallback. Owner settings report the selected path, version
and source; a system binary is not part of the installer source offer.

## Package scripts reference

| Script | Description |
|--------|-------------|
| `npm run build:frontend` | Vite build only (output in `build/` at root). |
| `npm run build:backend` | PyInstaller backend binary (plus ffmpeg) into `src-tauri/resources/backend/`. |
| `npm run dist:mac` | Backend + frontend + Tauri → macOS DMG (run on macOS). |
| `npm run dist:win` | Backend + frontend + Tauri → Windows NSIS installer (run on Windows). |
| `npm run dist:linux` | Backend + desktop staging + frontend + Tauri → Linux AppImage and deb (build on Ubuntu 22.04). |
| `npm run dist` | Backend + frontend + the current platform's Tauri bundles. |

## Version in the app

The renderer receives the version at build time through `define.__APP_VERSION__` in `renderer/vite.config.js`.
