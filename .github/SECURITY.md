# Security policy

This project is a self-hosted server. It holds a copy of somebody's music
library, stores provider credentials, and issues API tokens that grant access to
both. Please treat vulnerabilities here as you would in anything else that sits
on a home network.

## Reporting a vulnerability

**Do not open a public issue.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/flipspin/flipspin/security/advisories/new)
on this repository. That opens a draft advisory only you and the maintainer can
read.

Please include:

- what an attacker can do, and what access they need to start
- the version (`GET /api/health` and `GET /api/status` report it)
- how the server is deployed and reachable — loopback only, LAN, or exposed
- reproduction steps, ideally as `curl` commands
- logs if they help, with tokens removed

You should get a first response within **7 days**. If a report is confirmed, the
fix and an advisory go out together, and you are credited unless you ask not to
be.

## Supported versions

Only the latest release on `main` receives fixes. There are no maintained
release branches.

## What is in scope

The server, the desktop client, the packaging scripts, and the deployment
material in this repository. In particular: authentication, accounts and token
handling, path traversal in anything that resolves a library path, and the IPC
surface the desktop shell exposes to its renderer.

Out of scope: vulnerabilities in third-party dependencies, unless this project
uses them in a way that makes the impact worse than upstream's; and anything
that requires an attacker to already have shell access on the server.

## How access works

- **Accounts and per-device tokens.** Each person has an account; each of their
  devices holds its own token, revocable on its own. Tokens are stored as
  SHA-256 digests in `~/Krobi/users.json` (written `0600`), and a token's
  plaintext is returned exactly once, in the response that created it. A lost
  token is replaced, not recovered. Passwords exist only to sign a new device
  in; they are stored with a key-derivation function, never in plain text.
- **The first account claims the server.** While no account exists,
  `POST /api/claim` creates the owner; afterwards it answers `409` forever.
  Until that happens **anyone who can reach the port can claim the server**.
  The open window is announced in the server log and in `GET /api/status`.
  Set `KROBI_REQUIRE_SETUP_TOKEN=true` to require the one-time setup code the
  server writes to its log and to `~/Krobi/setup-token` (`0600`) — do this
  before starting an unclaimed server on a shared network.
- **Legacy shared secret.** If `KROBI_API_TOKEN` is set, any caller presenting
  it is treated as an owner. Setting it also removes the loopback exemption
  below.
- **Loopback exemption.** With no `KROBI_API_TOKEN` set, callers on the same
  machine are served without a token (that is how a desktop app running its own
  local server works); callers from any other machine need a token. A request
  carrying any forwarding header is never treated as local.
- **Public routes.** Only these answer without a credential: `/`,
  `/api/health`, `/api/status` (the handshake a client needs before it holds a
  credential), `/api/claim`, `/api/login`, `/api/ping` and the two Spotify
  OAuth redirect hops. Every other route is closed by default.
- **Guessing is throttled** on `/api/login` and `/api/claim`: failures are rate
  limited for the whole endpoint, and a wrong username and a wrong password are
  indistinguishable in status, body and timing.

## What you should know before deploying

These are documented behaviours, not vulnerabilities — but they decide whether a
deployment is safe:

- **Do not expose this server to the public internet.** It is designed for a
  local network or a VPN back into one. It terminates no TLS of its own, so
  tokens cross the network in the clear, and apart from the two routes above
  nothing is rate limited.
- **Claim a new server immediately**, or turn on `KROBI_REQUIRE_SETUP_TOKEN`.
- **`GET /api/health` and `GET /api/status` are deliberately public.** They
  report a version and an instance id; before the server is claimed,
  `/api/status` also reports its data directory. If that is more than you want a
  caller to learn, do not expose the port.
- **Media and progress-stream URLs may carry `?access_token=`**, because an
  `<audio>` element and `EventSource` cannot send headers. The server's own
  request log omits the query string; a reverse proxy in front of it will log
  it unless you configure it not to.
- **`KROBI_ALLOW_UNAUTHENTICATED_REMOTE=true`** turns all of the above off for
  remote callers. It exists as an escape hatch; do not use it on a network you
  do not fully trust.
