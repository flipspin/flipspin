# first-run — the wizard that sets up a nest, in the desktop app

## What it does

The desktop app is the only door: there is no browser client. A new install
goes straight to the first step, with no welcome screen, and walks through six
steps in one night-mode window: **Nest · Account · Music · Remote ·
Engines · Done**. The steps run across the top as one colour segment
each, and the current step sits in one centred panel: what to do on the left,
a picture of what it sets up on the right. A nest that has finished the wizard
never repeats it. A member gets a separate, short first run on their account.

## Decisions

| question | answer |
|---|---|
| where the wizard lives | the desktop app, for a nest on this computer or a server it connects to |
| look | always night (the app's night palette), whatever the app's mode; no tile wall, no glass |
| welcome screen | none: the wizard opens on Nest |
| steps | Nest · Account · Music · Remote · Engines · Done |
| language | v0.1.0 is English only, so there is no language switch |
| Nest | the nests as a list, this computer one row of it ("Make the nest here"), then "Setup link", then "Install on a server" |
| setup code on a server | always required, and handed over as one setup link the installer prints (see below) |
| default nest name | plain "Nest", never the computer's or an account's name: the name is public on `/api/status` and mDNS |
| Devices | not a step: a "Phone" row in Done opens Settings → My devices; Flipspin's phone apps are "Coming soon", OpenSubsonic apps cover mobile |
| Remote | kept as a step: "Use Tailscale" or "Later", nothing preselected; WireGuard and a domain stay in Settings → Remote access |
| Engines | an optional step: Lyrics, Stems and Analysis, nothing ticked, "Skip" always there; Ties and Recommendations shown as "Coming soon" |
| Lyrics | sync only in v1: "bring your lyrics, Flipspin syncs them"; no transcription |
| Spotify | an optional "Playlists de Spotify · Import" row on Music |
| Done | one row per area with "Swap", "Add" or "Connect", beside the album tiles; "Open Flipspin" lands in Home |
| members' first run | just "Devices" |
| password recovery | a reset command on the server + an admin reset for other accounts in Accounts |
| second device | sign-in in the wizard's look with the nest's name, plus a code approved from a device already signed in |
| discovery | an unclaimed nest is never advertised |

## The setup link

A server install proves who may claim it with a setup code, and hands that code
over as one line: `krobi://<host>:<port>/setup#<code>`. The installer prints it
at the end, the server prints it in its log while unclaimed, and
`flipspin setup-link` prints it again. The code rides in the fragment, so nothing
that logs URLs keeps it. The cases every side must agree on are in
[`contracts/setup-link.json`](../../contracts/setup-link.json).

On Nest, the "Setup link" field takes that line. The app connects
to the nest in the link and keeps the code only until the claim (at most an
hour, never logged), so "Create account" never asks for it. "Escribir una
dirección" is for a nest that is already set up but not in the list (over a VPN
or Tailscale). A nest on this computer reads its own code and needs no link.

## Server

| route | answer |
|---|---|
| `GET /api/status` | + `setupDone: bool` (additive). Unrecorded means a server from before the wizard: `true` once claimed. `POST /api/claim` records `false`. |
| `PUT /api/server/setup` `{done}` | owner only → `{setupDone}` |
| `GET /api/library/summary` | `{folder, songs, albums, artists}` from the memoized scan |
| `POST /api/me/devices/app-password` `{label}` | a device whose token is a typeable app password (OpenSubsonic) |
| setup link | built by the server from `contracts/setup-link.json` `make` (installer, log block, `flipspin setup-link`); read by the desktop from `parse` |

## States and controls

| when | the wizard shows |
|---|---|
| desktop, no nest chosen | Nest → `server:use` → the app relaunches |
| nest chosen, `isInit: false` | Account (after the app relaunches) |
| account created | Music → Remote → Engines → Done, then `PUT /api/server/setup {done: true}` |
| signed in as admin, `setupDone: false` | resumes at Music |
| `isInit: true` and no credential | sign in, not the wizard |

**Nest** ("Choose your nest"): the claimed nests found by `server:discover`, each a
row with "Available" and "Connect"; "This Mac" as one more row with "Crear
server aquí" (`server:use(null)`); "Setup link" (above); "Instalar en
un servidor" opens the one-line installer from `brand.ts::INSTALL_SCRIPT_URL`,
with direct Docker under "Other methods". An unclaimed nest is never
advertised: its setup link is how the app reaches it.

**Account** ("Create account"): username, password and its confirmation, and the
account card it creates beside them. The shell's local setup code, or the one
from a setup link, is sent with the claim; the code field shows only when
neither exists (an address typed by hand). The claim sends no nest name.
Revisiting Account from Done changes the existing username; it never claims the
nest a second time.

**Music** ("Your music"): the folder (with "Choose" on a nest this computer
hosts), its counts ("2,856 canciones · 179 álbumes · 97 artistas"), album tiles,
and the optional Spotify playlists import. On a server nest with an empty
folder, the mount line and a check-again action.

**Remote** ("Away from home"): "Use Tailscale", with the live detection status
and its address, or "Más tarde · Solo red local"; nothing preselected. Only a
verified Tailscale is recorded; everything else is "local network only".

**Engines**: Lyrics, Stems and Analysis, each with what it does, its models,
measured or approximate times per machine, and where it runs (on this
computer, as a helper for the nest). Ticking one and "Next" turns on
"Process for the nest" here; a computer that cannot be a helper sees the
checkboxes disabled with the reason in a tooltip. Ties and Recommendations are
"Coming soon". A failed start never blocks finishing.

**Done** ("You’re all set"): the editable nest name, then Nest, Account, Music,
Away from home, Engines and Phone, each with its value and an action.
"Phone · Connect" finishes the wizard and opens Settings → My devices
(OpenSubsonic apps; Flipspin's own apps are coming soon). A failed save stays
inline and offers retry.

**Members**: only Devices, "Paso 1 de 1": the Subsonic server, username
and an app password minted only on request, then the compatible apps. `GET
/api/me` adds `onboarded: bool`; "Skip" and "Next" both persist it with
`POST /api/me/onboarded` before opening the app.

## Recovery and signing in with a code

An operator with access to the server can run `python -m app reset-password
<username>` from the backend venv or in the container. It asks for the password
twice without echo; `--password-stdin` reads one line instead. Unknown users and
invalid passwords fail without changing anything. The installer helper exposes
`flipspin reset-password <usuario> [--password-stdin]`. The running server notices
the atomic file replacement without restarting; the CLI and server share an
advisory lock (`users.json.lock`). Existing device tokens stay valid.

A real owner resets another account via `POST /api/users/{id}/password`
`{newPassword}` → `{success, otherDevicesSignedOut: false, deviceCount}`. Members
get 403; sentinel principals and self-reset get 409 (self uses `/api/me/password`);
unknown accounts get 404; an account without a username gets 409. In Accounts the
admin types and confirms a password so they can choose how to pass it on; the
form clears it on success. This does not expire the password or sign out devices.
The existing password policy applies (8–256 characters after NFKC).

"Use a code" follows Quick Connect: the new device displays a code and an
already signed-in real account approves it from My account. Approval gives access
to the approver's account, including its role. Only approve a code displayed on
a device you intend to sign in.

| route (POST) | body → response |
|---|---|
| `/api/sign-in-code` (public) | `{deviceLabel}` → 201 `{code, secret, expiresIn: 600, pollInterval: 2}` |
| `/api/sign-in-code/poll` (public) | `{secret}` → `{credential: null}` while unapproved, expired, unknown or used; once approved, `{credential: {device, token}}` once only |
| `/api/me/sign-in-code` (`require_account`) | `{code}` → `{success: true}`; 404 for unavailable/expired/already approved codes; 409 for sentinels |

Codes have six characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, displayed as
`ABC 234`; input ignores ASCII spaces and hyphens and accepts lower case. They
expire 600 seconds after creation, including after approval. Display a countdown
as `m:ss`, rounded up, clamped to zero, then offer another code. Shared cases live
in `contracts/sign-in-code.json`; the renderer reads them in its test suite.

Limits are nest-wide, independent of IP/proxy headers: 20 code requests/minute,
10 approval attempts/minute (including successes), 120 polls/minute, at least two
seconds between polls of one secret, and at most 100 pending codes. Excess gets
429 with `Retry-After: 60`. The requester keeps a random 256-bit secret in memory;
only its SHA-256 digest is held server-side. Approval stores an account id; the
first authorized poll atomically mints a new device with the requested label and
removes the code. No plaintext device token waits in storage. Codes are transient:
a server restart cancels them. A revoked approver cannot mint a device. Closing the requesting app discards its pending code, which expires normally. Network loss after
redemption requires another code, since credentials are delivered once.

## Copy

Neutral and short, English in v0.1.0 (English is the source key in code). Headings:
"Choose your nest", "Create account", "Your music", "Away from home", "Engines",
"You’re all set". Actions: "Connect", "Make the nest here", "Next", "Back",
"Skip", "Open Flipspin". The account role is "Admin". Details live in
tooltips, never in hint lines.

## Decided per app on purpose

The desktop app owns the wizard, including Nest and the local folder picker.
Phone clients keep their own first-run flow.

## Not in scope

Changing the music folder of a remote nest (it is the deployment's mount),
the phones (next, via /port).
