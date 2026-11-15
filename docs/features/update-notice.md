# Update notice

The nest checks the latest stable GitHub release of `flipspin/flipspin`. Only its
owner sees a newer version in Settings: one Pending row, a teal mark beside the
nav version, and the version details in Status. Members keep their existing view.
The nest never installs an update or runs a command itself.

With `KROBI_UPDATE_CHECK=true` (the default), a stale or absent check runs 60
seconds after startup. Subsequent checks run daily, at a minute chosen once per
process. An ETag avoids downloading an unchanged release. Manual checks share
the same lock and persisted five-minute floor. GitHub rate limits defer checks
for at least 24 hours, honoring a later reset up to 48 hours. A failed check keeps
the last good version and stays quiet outside the details card.

One HTTPS request goes to `api.github.com`; GitHub sees the home IP and the
running nest version in the User-Agent. No accounts, library or release notes
are sent or stored. The response is streamed with a 1 MiB cap and a 10-second
request timeout; redirects are refused. Commands and release-link hosts are
constants in the server, never feed text.

Turn off **Buscar versiones nuevas** in Settings → Advanced, or set
`KROBI_UPDATE_CHECK=false` in the server environment. Off means no scheduled or
manual network requests. Turning it on queues one check, subject to the floor.
Environment values lock the setting using the existing configuration controls.

`GET /api/server/update` is an owner-only file read. `POST
/api/server/update/check` checks now, returning 202 after a run or 200 when
floored/off. Neither route adds anything to `/api/status` or broadcasts. An older
nest or a refused route contributes no update UI.

The install declaration determines the fix: `flipspin update` for an unpinned
script install, `docker compose pull && docker compose up -d` for Compose, and
no command for Unraid, systemd, desktop, unknown or pinned script installs.
Copy uses the command verbatim; Novedades opens the release in the system browser.
This notice covers the nest; desktop-app updates are separate.

When publishing manually, push the versioned and `latest` images for both
architectures before publishing the GitHub release. A future tagged-release
workflow must publish the release as its final step, so a notice always points
to an image that can already be pulled. Version numbering is a release decision.
