# Account security

This reference describes the account and credential design for a home server.
[the architecture](architecture.md) maps ownership and dependency boundaries;
[CONFIGURATION.md](CONFIGURATION.md) documents deployment settings.

## Device tokens

An account identifies a person; a device identifies one credential belonging to
that account. Several devices resolve to the same account id and therefore share
its personal library and playlists. Creating an account and enrolling another
device are separate operations. Device labels are display metadata: renaming one
must not rotate its credential or change its account.

Device tokens are opaque random secrets with 32 bytes of entropy. They remain
valid until revoked, without JWT claims, expiration or a refresh flow. A stored
credential directory makes immediate, individual revocation possible without a
second mechanism for invalidating otherwise valid signed tokens. Owners and
members can inspect and revoke their credentials from the device list.

Revoking a device closes its live change-event and download-progress streams
before the revocation response returns. Account removal closes those streams
for every device of the account. Queued events are discarded and outstanding
stream writes are cancelled; bytes already accepted by the HTTP transport
cannot be recalled. Other devices remain connected when only one is revoked.

The account file stores a SHA-256 digest rather than a recoverable token.
An unsalted digest is appropriate for a randomly generated 256-bit input; human
passwords require the separate derivation described below. Resolution uses a flat
digest index across all devices, with one lookup rather than a sequence of secret
comparisons. Plaintext is returned when a credential is minted, never in listings.

Subsonic app passwords are an explicit exception to nonrecoverable storage:
Subsonic token authentication needs the original secret, so a separate encrypted
vault retains a copy. Revocation removes that copy too. OpenSubsonic API keys
retain only their SHA-256 verifier and have no recoverable vault copy. Processing
credentials carry an enrollment flag that determines their restricted helper
kind. Ordinary account access does not authorize a device to pull helper work.

A helper credential can claim work, send heartbeats and results, download audio
inputs, read its own identity and processing limits, and send goodbye. These
permissions apply to the unified helper protocol and its feature aliases.
Helpers enrolled by owners can read shared audio inputs without personal-library
links. They cannot administer accounts, enroll devices, install sources, browse
the library, or use Subsonic. The central gate denies other application routes
with 403; the helper's identity reports `isOwner: false`. The stored enrollment
flag determines this restriction without changing the token or enrollment body.

Media and Opus stem responses support one byte range with a Range header of
at most 256 bytes. Multiple ranges, repeated Range headers and longer values
are ignored and receive the whole file with status 200. Normal single-range
seeks retain 206 responses, and unsatisfiable single ranges receive 416.

## Usernames

Usernames contain 3–32 ASCII letters, digits, dots, underscores or hyphens, with a
letter or digit first. Surrounding whitespace is removed. Display spelling keeps
the entered case, while matching uses the lower-case form. ASCII limits avoid a
Unicode normalization and case-folding policy that could allow visually identical
lookalikes to identify different accounts. Display labels remain separate from
sign-in identifiers.

Validation applies when choosing a username. Login performs normalization and
lookup without rejecting an invalid username shape first: invalid and unknown
identifiers must produce the same failed-login result. An authenticated account
choosing a name can receive a collision error; the anonymous login surface cannot
use that error to reveal whether a name exists.

## Constant-time failed lookup

Unknown usernames, missing password hashes, malformed hashes and incorrect
passwords use the same login failure status and body. Password verification
performs one scrypt derivation on every call. A missing or unusable hash uses a
dummy salt and the current cost parameters, preventing the cheap lookup failure
that would otherwise reveal account existence through response time. Hashes with
older parameters still verify at their recorded cost; this is equal derivation
work for ordinary failures, not a guarantee of identical wall-clock latency.
Derived keys, setup tokens and the legacy shared secret use constant-time
comparisons where secrets are compared directly.

The login failure bucket is global to the endpoint, with ten failures per
60 seconds. A per-account bucket could reveal the existence of a username or
allow targeted lockout. A caller-address bucket would depend on proxy attribution
and permit distributed guessing. Submitted usernames and passwords are excluded
from failed-login logs, including password length and prefixes.

## Owner and member roles

The account role is either `owner` or `member`; unrecognized roles narrow to
member. Ordinary device credentials inherit their account's role. Owners manage
accounts; members can enroll devices for their own account. A device request cannot choose
a different account through its body. The final owner cannot be removed, and the
final device of an account cannot be revoked through device sign-out. Deleting an
account is a separate operation that removes all its credentials together.

Synthetic principals represent legacy shared-secret access, local access,
explicitly unauthenticated remote access and unresolved identity. They have no
account row or personal devices. A synthetic owner's administrative authority
must not be mistaken for an account capable of owning personal data. Account
administration routes that require a real owner apply both checks.

## Claim and setup code

A new server has no owner credential with which to create its first account.
The public claim route creates that first owner, and the existence of an account
closes the claim window. The empty-table check and creation happen under the same
reentrant account-file lock, so two concurrent claims cannot both succeed. An
early HTTP check only avoids unnecessary setup-token work; the store check is
the authority. Corrupt, newer or unexpectedly missing account files fail closed
rather than reopening setup.

The setup code is a random 32-byte secret generated on unclaimed startup in both
modes. In the default open mode, a label alone can claim the server. Strict mode,
selected by `KROBI_REQUIRE_SETUP_TOKEN`, additionally requires the code. Open mode
lets people installing it finish setup from a client without shell access, while
accepting that anyone who can reach the unclaimed server can win the claim.
Before exposing an unclaimed server to an untrusted network, require the code and
complete setup promptly. Strict mode trusts access to the console or data
directory.

The code is written to a private `setup-token` file and shown on the console,
never in file logs, public status or URL query strings. An in-memory cache keeps
the value stable when the file cannot be written. Restart reuses an existing
nonempty file. Only rejected required-code attempts count toward the global
five-failure, 60-second claim throttle. Successful claim clears the code. Optional
username and password fields must be supplied together, preserving older clients
that claim with only a label. An owner creating an account follows the same rule:
`POST /api/users` takes the person's initial username and password together (the
desktop requires both), with the same validation, a 409 for a taken username, and
neither the password nor its hash in the response or the logs. Cosmetic server-name and setup-state updates cannot
turn a successful claim into an error that hides its newly minted token.

## Sign-in codes

A new device can request a six-character code and a separate 256-bit polling
secret. Codes expire after ten minutes and pending state is process-local; a
restart cancels it. Creation is restricted to the supported local or VPN network
paths. A code can target a username, but approval still requires an authenticated
real account and enforces that target. Inspecting a typed code reveals its facts
without approving it.

Only the digest of the polling secret is stored. Approval records the account;
it does not leave a plaintext device token waiting in memory. Redemption with the
polling secret mints a device atomically once. Declining, expiry, polling cadence
and global attempt limits apply independently of ordinary token authentication.

## Recovery

A username and password provide a way back after every signed-in device is lost.
Public login verifies the password and mints a new device credential. Older
accounts without a username or password keep working with existing tokens and
can adopt both through authenticated self-service, or an owner can set both for
them in one reset: the reset's optional username applies only to an account that
has none. A password cannot be set before a username, because it would have no
usable sign-in address.

Changing a password requires the current password only if one already exists.
Both a self-service change and an authorized reset preserve existing device
credentials. This makes routine password changes independent of device sign-out.
If a leaked password has already been used to mint a token, changing the password
alone does not evict that device: it must also be revoked in the device list. The
response states that other devices were not signed out and reports their count.

A real owner can reset another account's password. An operator with access to the
server data directory can use `python -m app reset-password <username>` with an
interactive prompt or `--password-stdin`. Passwords never travel as command-line
arguments. Recovery uses the server environment configuration and preserves the
account file's ownership, including when invoked from a root container shell.
It shares file locking and reload detection with the running server, so changes
become visible without a restart. A retained token, another real owner, or this
operator access is necessary if password sign-in is unavailable.

## Password hashing

Passwords are normalized with NFKC before validation, hashing and verification.
Case and surrounding whitespace are preserved. The policy requires 8–256
characters after normalization, without composition rules. The lower bound
permits passphrases; the upper bound limits work on the public login endpoint.

The standard-library scrypt implementation uses `n=32768`, `r=8`, `p=1`, a fresh
16-byte salt and a 32-byte derived key. Its main memory cost is about 32 MiB per
derivation. Memory hardness raises the cost of offline guessing against a stolen
account file or backup. An explicit OpenSSL memory allowance avoids the default
cap at that boundary. Independent salts keep equal passwords from producing
identical stored values.

Each hash is one self-describing field:
`scrypt$n=32768,r=8,p=1$<salt base64>$<key base64>`. Algorithm, parameters, salt
and key stay together so a migration cannot update only half of a credential.
A successful login can replace an older-cost hash with current parameters while
the password is available, in the same write that creates the new device.

Derivation runs outside the store lock so a sign-in does not block all token
resolution. Password changes and login read under the lock, derive outside it,
then re-read under the lock. A concurrently changed hash cannot be overwritten
using a stale current-password check or used to mint a device with the old
password. Plaintext passwords and stored hashes are excluded from logs and
response models.

## Account storage

Account data is written atomically with private permissions. The schema reader
rejects unsupported versions and malformed rows, and backs up older supported
files before their first migrating write. A missing file means first boot only
when persisted claimed state and the store's prior observations permit it.

Version 1 stored one token digest per account. It reads as one device inheriting
the account id, keeping that device addressable across reloads. Version 2 adds
devices without username/password fields; absent credentials continue to mean
unset. Version 3 writes the current shape. An unusable optional username can be
dropped while preserving the account's device access. Duplicate indexed names
or digests retain the first entry and emit a warning.

The account-file lock combines a reentrant thread lock with an operating-system
lock on a separate inode that survives atomic replacement. Nested claim/mint and
authenticate/add-device operations remain serialized. File signatures detect
external recovery writes and reload both indexes. Mutations rebuild both indexes
before saving; leaving a stale digest index after revocation would keep access
alive. Last-seen writes are coarse, best-effort metadata rather than an audit
trail, and persistence failures must not break token authentication.

## Request authentication

A valid device credential authenticates regardless of legacy shared-secret
configuration. A presented but unresolved credential is rejected even on
loopback. With a shared secret configured, all clients must authenticate. Without
one, a request carrying no token can use synthetic local-owner access only when
its peer is loopback, its Host is `localhost`, `127.0.0.1` or `[::1]` with an
optional port, and it has no Origin header or an explicitly allowed CORS
origin; `Sec-Fetch-Site: cross-site` without an Origin refuses it. Opaque `null`
origins are refused by default and require explicit `KROBI_CORS_ORIGINS=null`
opt-in. Non-loopback access is refused unless the operator
explicitly enables unauthenticated remote access, which produces a member
principal.

The request peer distinguishes local access from network access; binding to
`0.0.0.0` does not. Any forwarding header prevents the local exception because
proxy rewriting can otherwise make an untrusted caller appear to be loopback.
The gate stores the resolved principal on request state; later authorization
reads that decision instead of resolving the credential again. Local-action
endpoints apply a separate local gate because opening a file on the server is
not equivalent to acting on a remote client's computer.

Malformed or duplicate Host authorities are rejected with 400 before
authentication or body parsing. Public-route and library-write decisions use
the ASGI routing path, with the deployment root path removed on a segment
boundary. Fetch Metadata headers never establish identity or grant authority.

Public health, status and ping probes allow startup and reachability checks
before credentials exist. Claim, password login and sign-in-code creation/polling
remain public because they establish credentials and enforce their own guards.
Spotify login requires an owner token; its public callback validates OAuth state. The application-level root
health check is outside router dependencies. Public status reports capability,
such as whether password sign-in exists, without enumerating accounts.

## Upload admission

Helper multipart uploads authenticate and require an enrolled owner helper
before consuming the body or creating temporary files. Receive-time byte limits
apply independently of Content-Length. All bounded form parsers share a 1 GiB
in-flight budget in the single backend worker. Unknown lengths reserve the full
route limit; declared lengths reserve that size and grow before extra bytes
reach the parser. Reservations last until the form and temporary files close,
including result handling. Missing or dishonest lengths cannot overbook it.
Exhaustion returns 503 with `Retry-After: 1`; admission refusal consumes no body.
Failed, disconnected and cancelled uploads release reservations and close files.

## Discovery after claim

mDNS advertising begins only after a server has been claimed. An unclaimed
installation may permit first-owner creation without a setup code, so advertising
it would unnecessarily widen the opportunity to claim it. Successful claim
refreshes the advertiser; failure to advertise must not hide the owner token.
The advertised server name identifies the server and must not derive from an
account's name. Discovery and public status do not disclose account credentials
or setup codes.

## Account routes

HTTP handlers are grouped by profile, devices, credentials, claim, users and
sign-in codes. The original `accounts.routes` router and `accounts.identity`
imports remain compatibility entry points. Request and response names, route
order, operation ids and published OpenAPI descriptions remain stable through
this split. Published descriptions are retained for schema compatibility; this
reference holds the current design rationale.

Self-service routes derive their account from the resolved principal. Response
models expose identity metadata with the existing camelCase vocabulary and
exclude token digests and password hashes. Account-deletion preview and execution
share eligibility checks for acquired, exclusive files under the current music
root; safe path resolution and failures cannot make unrelated files eligible.
Owner attention details are private to real owner accounts.

## Subsonic guessing limits

Failed credentials share independent windows for the peer IP and, when given,
the normalized username (30 failures per 60 seconds each). A global 300-failure
window also bounds distributed guessing and bucket churn. Valid credentials
continue to work while failure windows are full. Forwarded peer addresses are
accepted only from explicitly trusted proxies; see the proxy and URL policy in
[configuration](CONFIGURATION.md#public-server-url-and-proxy-policy).
