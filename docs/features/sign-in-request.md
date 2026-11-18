# sign-in-request — let a new device in from your phone, like a TV sign-in

Only the account's own devices receive approval requests, limited to the local
network or VPN. Codes contain six characters.

## What it does

Builds on the sign-in code (`docs/features/first-run.md` → "Use a code",
`contracts/sign-in-code.json`). The new device asks for the **username**, then
waits on one screen: "Request sent to your devices", the code (big,
`K7M · 4QX`) and a countdown. Every signed-in
Flipspin client **of that account** shows a sheet: which device asks, from where,
the account, the code to match, "Decline" and "Approve" at the same size. One
tap signs the new device in. The "Approve code" button beside
"Add device" in My account → Devices opens the typed fallback, then
the same sheet.

## Server

| route | who | answer |
|---|---|---|
| `POST /api/sign-in-code` `{deviceLabel, username?}` | public, **home or VPN only** | as today (201 `{code, secret, expiresIn, pollInterval}`); `username` is new and optional. **403** `detail: "outside-network"` when the request did not come from home or a VPN |
| `POST /api/sign-in-code/poll` `{secret}` | public | as today, plus `{declined: true}` once the request was declined (then the secret is dead) |
| `GET /api/me/sign-in-requests` | `require_account` | `{requests: [{id, deviceLabel, network: "local" \| "vpn", createdAt, expiresAt, code}]}` — only requests made **with this account's username**, unexpired, unapproved |
| `POST /api/me/sign-in-requests/{id}/approve` | `require_account` | `{success: true}`; same effect as `POST /api/me/sign-in-code` with that code; 404 when gone or not this account's |
| `POST /api/me/sign-in-requests/{id}/decline` | `require_account` | `{success: true}`; the waiting device's next poll says `declined` |

- **Network** (contract `sign-in-code.json` → `network`): the requester's
  address goes through `remote_access.outside_via` — `local`, `vpn`, `tailscale`
  may start a request; `proxy` and `open-port` get 403. Approving needs only a
  signed-in account, from anywhere.
- **Username**: matched against account usernames, case-insensitive. An unknown
  username still gets a code (no account enumeration): it is simply listed for
  nobody, and the typed fallback still works.
- **Limits** (on top of first-run's): at most 3 pending requests per username;
  a fourth replaces the oldest. A declined or approved request leaves the list
  at once.
- Nothing about the requester's address is stored; `network` is the kind only.
- Signed-in clients poll `GET /api/me/sign-in-requests` every 5 s while the app is
  in the foreground (desktop: window focused or visible; phones: app active), and
  once on focus.

The typed fallback reads the same facts with authenticated
`GET /api/me/sign-in-code/{code}` → the request row above. It does not approve
anything. `POST /api/me/sign-in-code/{code}/decline` → `{success: true}` rejects
that code; approval continues to use `POST /api/me/sign-in-code`. Both require a
real account (409 for sentinels) and return 404 for unavailable codes. Inspection
is limited to 20/minute; decisions share the existing 10/minute approval limit,
including failed attempts. Possessing the code allows the fallback even
when its username was omitted or unknown. No account or address is exposed.

The exact network restriction copy "Only from home or the VPN" is an exception
in `contracts/one-account.json`: here “casa” describes the network boundary.

## Approving from another app

Use the "wants to sign in" sheet on a signed-in device, or type the displayed
code in My account → Devices → "Approve code". The waiting screen shows
no URL or QR; the phone apps approve through their own sheets or typed code.

## States and controls

| where | state | shows |
|---|---|---|
| new device | asking | "Username" field + "Continue"; "Sign in with a password" |
| new device | waiting | "Request sent to your devices" (info dot) · code · `m:ss` · "Sign in with a password" |
| new device | approved | ✓ "Done" · "signing in as {{user}}…", then the app |
| new device | declined | "Declined" · "Request another code" |
| new device | expired | a new code replaces it: "New code" · "the previous one expired" |
| new device | outside network (403) | "Only from home or the VPN" · "Sign in with a password" |
| approver | request | sheet: "wants to sign in" · device label · "local network" / "VPN" · "hace N s" · "Account" · "Code" · "Decline" · "Approve" (equal) |
| approver | approved | ✓ "{{device}} connected" · "en My account → Devices" |
| approver | typed fallback | ghost small "Approve code" button in the Devices header, left of "Add device" → small "Code from the other device" dialog: six single-character boxes, grouped 3 · 3; first autofocus, type ahead right, Backspace left; paste normalises case/spaces/hyphens per `contracts/sign-in-code.json`, only its alphabet accepted. Sixth character inspects the code and replaces the dialog with the same sheet; no submit button. Not found/expired: one shake, clear boxes, "Invalid code". Esc/✕ close. One labelled group; each box "carácter N de 6". |

No warning paragraph: the sheet's facts (device, network, account, code to match)
do that job (RFC 10027 §6.1.13). The old line "Only approve the code displayed on
a device…" goes.

## Copy (exact strings)

"Sign in with another device" · "Username" · "Continue" · "Aviso enviado a tus
dispositivos" · "Sign in with a password" · "Done" · "entrando como
{{user}}…" · "Declined" · "Request another code" · "New code" · "el anterior
caducó" · "Only from home or the VPN" · "wants to sign in" · "local network" · "VPN" ·
"Account" · "Code" · "Decline" · "Approve" · "{{device}} connected" · "en Mi
cuenta → Devices" · "Approve code" · "Code from the other device" ·
"Invalid code" · "character {{n}} of 6".

New English copy: "Approve code" · "Code from the other device" · "Invalid code" ·
"character {{n}} of 6".

## Decided per app on purpose

- Waiting device: desktop now; the phones' own sign-in gets it with
  the pending phone port of "Use a code".
- Approver: desktop and both phones (sheet + polling + typed fallback).

## Pinned by

`contracts/sign-in-code.json` → `network` (how a request came in → allowed).
`contracts/wire/` snapshots for the new `GET /api/me/sign-in-requests` body.
