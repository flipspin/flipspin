# Repository tooling

Paths are relative to the repository root. Scripts own verification, packaging
and release drivers. Run `node --test scripts/*.test.mjs scripts/*.test.cjs`
after changing behavior. Keep release workflow boundaries intact.

`.github/areas.yml` owns area globs. After editing it, run
`node scripts/check-areas.mjs --write-labeler` to regenerate label rules.
`node scripts/check-areas.mjs` verifies coverage, guide paths and labeler drift;
`make lint` includes that check. Changes routing is in `scripts/changes.mjs`.

## What guards these rules

| Rule | Guard |
|---|---|
| Release and packaging drivers | `node --test scripts/*.test.mjs scripts/*.test.cjs` |
| Area coverage, guide paths and generated labels | `scripts/check-areas.mjs` |
