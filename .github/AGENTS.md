# Repository automation

Paths are relative to the repository root. Pin actions by commit SHA with a
version comment. Never execute pull request code with a write token.

`.github/areas.yml` owns path routing and generated `.github/labeler.yml` rules.
Run `node scripts/check-areas.mjs --write-labeler` after changing globs, then
`node --test scripts/*.test.mjs scripts/*.test.cjs` and actionlint for changed
workflows. Every CI job belongs in the conclusion job's needs; branch protection
should require only that conclusion check.
