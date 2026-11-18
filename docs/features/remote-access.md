# remote-access — reach the nest from outside the house, without opening a port

## What it does

The wizard gets a step after "Devices": **Remote access** (stepper label
"Remote"). The same section lives in Settings → Access → Remote access. It offers four ways out of
the house — Tailscale, WireGuard, a domain with HTTPS, or local network only —
and checks the one chosen. Every client then knows up to three addresses for
the nest (local, Tailscale, domain) and uses whichever answers as *this* nest
(same `instanceId`), local first.

## Server

| route | who | answer |
|---|---|---|
| `GET /api/server/network` | any signed-in principal | `{lan: [url], tailscale: {ip, name, url} \| null, externalUrl: url \| null, route: "tailscale" \| "wireguard" \| "domain" \| "local" \| null, outside: {at: ISO-8601, via: "vpn" \| "tailscale" \| "proxy"} \| null}` (`route` and `outside` added 2026-10-28, additive) |
| `PUT /api/server/remote-route` `{route}` | owner | `{route}`; **422** `detail: "unknown-route"` for anything but `tailscale` · `wireguard` · `domain` · `local` |
| `PUT /api/server/external-url` `{url: string \| null}` | owner | `{externalUrl}`; **422** with `detail` = a reason code from the contract (`needs-https`, `has-path`, `has-credentials`, `not-a-url`) |
| `GET /api/status` | public | public handshake body; uses the configured CORS allow list, including Tauri and Vite dev origins |

- `lan` — `http://<ip>:<port>` for every address `discovery.lan_ipv4_addresses()`
  reports, minus Tailscale's (`100.64.0.0/10`).
- `tailscale` — the first `100.64.0.0/10` address on an interface, `url` =
  `http://<ip>:<port>`; `name` is the MagicDNS name from `tailscale status --json`
  (`Self.DNSName`, trailing dot dropped) when the binary answers in 2 s, else null.
- `externalUrl` — stored in `instance.json` beside `instanceId` and `name`
  (read-modify-write, like the name). Normalised by the contract's `externalUrl`
  rule; the server is authoritative and runs the same cases.
- `route` — the way out the owner picked in "Remote access", stored in
  `instance.json` like `externalUrl`. `null` until someone picks (older nests);
  clients then infer it (contract `reach`, rule *no route*).
- `outside` — the last time a signed-in client reached the nest **from outside
  its local network**, and how. This is the only proof a router VPN can have:
  WireGuard runs on the router, so the nest has no address of its own for it
  and a check from home can never prove it. Classified on every request that
  passed `require_api_token` with a real credential, from the per-request
  client address (after uvicorn applies `X-Forwarded-For`):
  - loopback, or inside one of the nest's own interface networks → local, not
    recorded;
  - the default gateway's address → `vpn` (a router that masquerades its VPN
    clients makes them all look like the router; nothing else on the LAN side
    of the router calls the nest);
  - `100.64.0.0/10` → `tailscale`;
  - any other private address (`10/8`, `172.16/12`, `192.168/16` outside the
    nest's own networks — e.g. WireGuard's `10.1.0.0/24`) → `vpn`;
  - a public address that arrived with a forwarding header → `proxy` (the
    domain through Caddy);
  - a public address with no forwarding header is port 8000 open on the
    router — the configuration this feature forbids; not recorded as proof.
  Kept in memory and written to `instance.json` at most every 5 minutes
  (`at` only moves forward); the client address itself is never stored or
  sent — only the time and the kind.
- ⚠ Never on `/api/status`: the handshake is public, and the domain plus the
  tailnet name are a map of the deployment.

## States and controls

| card | shows | check |
|---|---|---|
| Tailscale, detected | "Detected" + the tailnet address (name, else IP) with copy | probe the Tailscale URL; pass = same `instanceId` |
| Tailscale, not detected | the two install commands with copy, "Volver a buscar" | re-reads `/api/server/network` |
| WireGuard | the local address with copy | none from here — proven by `outside.via == "vpn"` (a signed-in device came in through the router's VPN) |
| Dominio con HTTPS | domain field, the Caddyfile with copy, "Check", "Save" | probe `https://<domain>/api/status`; "Save" = `PUT external-url` (owner) |
| Solo red local | — | "Skip" in the wizard |

Probe results (contract `probe`): `same-nest` → "Connected"; `other-nest` →
"Another nest answers"; `not-krobi` → "No es un server de Flipspin"; `unreachable` →
"No answer". A domain is saved only after `same-nest`, except the owner may
save anyway from Settings (a domain checked from inside the LAN can fail on
hairpin NAT and still work outside; tooltip on "No answer": "Desde la red
local puede fallar y funcionar fuera.").

Picking a card in Settings stores it (`PUT /api/server/remote-route`, owner);
the screen opens on the stored route. In the wizard, "Next" stores the
route it finishes on.

Always under the cards, one line: "Don't open port 8000 on your router."

### The status line and the chain (contract `reach`, `ago`)

The status line and the picture both come from the **chosen route**, never from
counting rows: one rule (`reach`) takes `route`, `outside`, whether Tailscale
is detected, whether a domain is stored, and the probe verdicts of the
Tailscale and domain rows, and answers `reach` (`ok` · `bad` · `local` ·
`none`), the two links (`ok` · `bad` · `none` · `off`) and what the status
line names after the route (`detail`).

The chosen card carries the same verdict as the first link, as a small
**badge on its icon** (bottom-right corner): `ok` green check, `bad` red ✕,
`none` grey clock; no badge for "Local network only" (`off`). The blue selection
stays: it says *chosen*; the badge says *whether it works*.

The picture: Phone ("fuera") — link — the way out — link — the nest. Each
link is one line from circle to circle with an **icon badge** in its middle and
a word under it: `ok` green check, `bad` red ✕, `none` grey clock, `off` a
dotted line with a dash. Words: "connected" · "no answer" · "sin comprobar"
· "sin uso aún" · "local network" · "hace …" (contract `ago`) · "no access".

| route | status line | phone → way out | way out → nest |
|---|---|---|---|
| wireguard, `outside.via == vpn` | ok · "WireGuard · hace 2 h" | ok "hace 2 h" | ok "local network" |
| wireguard, never | none · "WireGuard · sin uso aún" | none "sin uso aún" | ok "local network" |
| tailscale, probe `same-nest` | ok · "Tailscale · conectado" | ok "connected" | ok "connected" |
| tailscale, no probe, `outside.via == tailscale` | ok · "Tailscale · hace 2 h" | ok "hace 2 h" | ok "connected" |
| tailscale, not detected | bad · "Tailscale · no detectado" | off "no access" | off |
| domain, probe `same-nest` (or `outside.via == proxy`) | ok | ok | ok |
| domain, no answer | bad · "Dominio · sin respuesta" | bad "no answer" | none "sin comprobar" |
| local | local · "Local network only" | off "no access" | off |

### Which address a client uses (contract `pick`)

Candidates in order: the address the client was set up with, then every `lan`,
then `tailscale.url`, then `externalUrl`, duplicates dropped. The first whose
`/api/status` answers with the nest's `instanceId` wins; none → offline.
Credentials stay keyed by the address the client was set up with — the others
are transports, never identities. Clients refresh their copy of
`/api/server/network` on every successful connection.

- Desktop: chosen at startup, in Rust, before the window reads `backendUrl`; a
  network change mid-session needs a relaunch (v1).
- Phones: on a failed request, walk the list once before reporting offline.

## Copy (exact strings)

| where | text |
|---|---|
| step heading / stepper | "Remote access" / "Remote" |
| cards | "Tailscale" · "WireGuard" · "Domain with HTTPS" · "Local network only" |
| card tags | "Recommended" (Tailscale) · "Advanced" (Dominio) |
| field label | "Domain" (placeholder `musica.ejemplo.com`) |
| buttons | "Check" · "Save" · "Volver a buscar" · "Copy" · "Skip" · "Next" |
| status line | "Accesible desde fuera" · "Sin acceso desde fuera" · "Local network only" · "Sin comprobar" (never "casa": `contracts/one-account.json`), then "<route> · <detail>" |
| chain | "Phone" · "fuera" · "connected" · "no answer" · "sin comprobar" · "sin uso aún" · "local network" · "no access" · "now" · "hace N min" · "hace N h" · "hace N d" |
| states | "Detected" · "Not detected" · "Connected" · "Another nest answers" · "No es un server de Flipspin" · "No answer" |
| errors (422) | `needs-https` "Use https://" · `has-path` "Just the domain, no path" · `has-credentials` "No username or password" · `not-a-url` "Not an address" |
| warning | "Don't open port 8000 on your router." |
| Settings rows | "Local address" · "Tailscale" · "Domain" |

Install commands shown for Tailscale (Linux nest):
`curl -fsSL https://tailscale.com/install.sh | sh` and `sudo tailscale up`.
Caddyfile: `<domain> {\n\treverse_proxy <first lan host>:<port>\n}`.

## Decided per app on purpose

- The wizard step and the domain/Caddy card: desktop (they set up a
  nest). The phones get only the Settings rows (read-only addresses), the
  `pick` switching, and the status line from `reach` (the chain picture is
  desktop-only; a phone may draw it, it must not contradict it).
- How a client probes: Rust `server:probe` on desktop, the platform HTTP client on the phones.

## Pinned by

`contracts/remote-access.json` — `externalUrl` (normalisation + reason codes),
`probe` (status body → verdict), `pick` (candidates + answers → address),
`reach` (route + proof + verdicts → status line and links), `ago` (seconds →
"hace …"), `outsideVia` (a client address → `vpn` · `tailscale` · `proxy` ·
`local` · `open-port`, server only).
`contracts/wire/server-network.json` — the `GET /api/server/network` body.

## Not in scope

Trusted proxies (`--forwarded-allow-ips '*'` stays: nothing trusts the client
address — the loopback rule refuses any forwarded request and the throttles are
global). Setting up Tailscale or Caddy for the person (the install script's
agent, plan §2). Cloudflare Tunnel. Switching addresses mid-session on desktop.

## Custom proxy headers

In Settings → Access → Remote access, add name/value pairs under **Custom headers**
when a reverse proxy requires them. When joining a protected nest, enter its full
HTTP(S) address (or paste its setup link), expand **Custom headers**, save the
values, then test/connect. For Cloudflare Access service tokens, add
`CF-Access-Client-Id` and `CF-Access-Client-Secret` with the values from your
service token. Flipspin sends them only to that configured nest origin and path
prefix, including media, downloads and helper requests. Redirects are not followed.

Values use the desktop credential store (OS vault, session memory if unavailable,
or the explicitly chosen private credential file). Saved values are masked and
can be replaced or removed. Pairing links, setup links and QR codes never include
these secrets; add the headers separately on each device.
