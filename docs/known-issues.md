# Known issues

Problems we know about in the current release. Check here before opening an issue.
Each issue has the `known-issue` label; its line here links it.

| Issue | Affects | Workaround | Tracking |
|---|---|---|---|
| macOS asks for the keychain password several times on first launch | macOS, upgrading from a build before 0.1.0-rc.15 | Choose **Always Allow** on each prompt; it happens once | to be filed |
| No audio source is installed by default, so nothing can be downloaded | all | Settings → Plugins → Install YouTube (owner only) | to be filed |
| Server data, environment variables and the service still use the old `krobi` name (`~/Krobi/`, `KROBI_*`, `krobi-backend`) | all servers | None needed; renaming them would break existing installs | to be filed |
| Native iPhone and Android apps are not released yet | phones | Use any [OpenSubsonic client](docs/features/opensubsonic.md) | to be filed |
