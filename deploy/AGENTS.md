# Deployment assets

Paths are relative to the repository root. This area owns installers, service
configuration and distribution templates. Keep documented defaults aligned with
`docs/CONFIGURATION.md` and preserve operator data during upgrades.

Run the relevant script tests with `node --test scripts/*.test.mjs scripts/*.test.cjs`.
Server image changes also need `make qa-install` with isolated development data.

## What guards these rules

| Rule | Guard |
|---|---|
| Installer, upgrade and packaging behavior | `node --test scripts/*.test.mjs scripts/*.test.cjs` |
| Clean server installation | `make qa-install` with isolated data; requires Docker |
