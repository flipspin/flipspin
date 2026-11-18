# Source plugins

Flipspin ships no audio sources. An owner installs a source from a Git repository
or a folder on the nest in Settings → Plugins → Add a plugin. YouTube is an
external plugin installed through the same workflow as any other source. An
empty nest is valid: acquisition returns `no-sources` (409).

See [Source plugins](PLUGINS.md#source-plugins) for installation, storage,
security and the protocol. The host's port, supervisor and installer live under
`backend/app/domains/acquisition/sources/`. Extension manifests are validated
by `backend/app/infra/extensions.py` before any source code executes.

Recording matching, retry policy, health, capacity, validation, publication and
library linking belong to Flipspin. Source tools, updates and their own persistent
state belong to the plugin. Full decoding and at least 90% of the expected
duration are required before publication. The source returns neutral audio facts;
only acquisition's import stage can publish files to the shared catalog.

The historical URL/search routes and `youtube_url` inputs remain compatible.
URLs dispatch to the enabled source that advertises their exact hostname;
search dispatches to the first enabled source in provider order. The historical
`youtube` id preserves preferences and the `YouTube Downloads` folder in existing
libraries. Other sources use `<Name> Downloads`.

`contracts/source-plugin.json` is exercised by the host suite against an
independent fake subprocess and a local, dependency-free installable package.
Source repositories should consume the same contract in their own suites.
