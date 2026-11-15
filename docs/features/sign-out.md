# sign-out — "Sign out" signs this device out of its account

## What it does

In Settings → My account → the device list, the row of the device you are holding
says "Sign out" instead of "Remove". Confirming deletes the token this
device stores and takes you back to the sign-in. Nothing on the server changes:
the account, its library and this device's row all stay.

## Server

none. Sign-out is local. Killing the credential on the server is "Remove" on that
device's row from another device (`DELETE /api/me/devices/{id}`), unchanged.

## States and controls

| when | the screen shows | tapping it does |
|---|---|---|
| the device list loaded and a row has `isCurrent: true` | that row's action is "Sign out" (never "Remove") | opens the confirm |
| a token is stored but no row is this device (offline, a server without devices, the shared server secret, still loading) | a standalone "Sign out" under the list (phones) | opens the confirm |
| no token stored | nothing | — |
| confirm → "Sign out" | the stored token is deleted, account state in memory (who am I, the device list) is dropped, Settings closes, the first run opens at its Account step with the stored nest address filled in | — |
| the token could not be deleted | stays signed in, failure toast | — |
| an emptied token field saved in Settings (phones) | same as signing out: the first run comes back | — |

Downloads, the offline snapshot and play history stay on the device; the sign-in
screen covers them until somebody signs in.

## Copy (exact strings)

| where | text |
|---|---|
| button | "Sign out" (icon: log-out arrow) |
| confirm title | "Sign out on this computer?" desktop · "¿Cerrar sesión en este iPhone?" iOS · Android: its own device noun, the one its "este …" chip uses |
| confirm detail, desktop | "Para volver a entrar hace falta tu contraseña o un código. No se borra nada del server." |
| confirm detail, phones | "Para volver a entrar hace falta un token o el código QR de otro dispositivo. No se borra nada del server." |
| confirm buttons | "Sign out" (danger) + the app's existing cancel verb (desktop "Dejarlo", iOS "Cancel") |
| failure toast | "No se pudo cerrar la sesión · sigues dentro" |

## Decided per app on purpose

- Confirm shape: desktop a modal; iOS an inline two-step inside the card, the
  same as its "Quitar de la cuenta"; Android follows its own existing
  device-remove confirm.
- The standalone button exists on the phones only: the desktop usually is the
  server's machine and its list loads.
- The confirm detail differs because the phones sign in with a token or a QR,
  the desktop with a password or a code.

## Pinned by

No contract file: there is no shared computation, only the visibility rule in
the table above and the copy.

## Not in scope

Revoking the credential on sign-out; wiping downloads or history on sign-out.
