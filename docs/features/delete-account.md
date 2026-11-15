# delete-account — eliminar una cuenta, solo ella o con sus canciones

## What it does

An admin deleting an account chooses what goes with it. **Solo la cuenta**: its
devices stop working and its library empties, its songs stay on the nest and its
playlists pass to the admin. **La cuenta y sus canciones**: also deletes from the
nest the songs only that account brought — downloaded by it and saved by no other
account — and its playlists. Both choices show their numbers before anything happens.

## Server

- **New** `GET /api/users/{user_id}/deletion-preview` (owner only; 404 unknown user) →
  `{devices, songs, playlists, removable: {count, bytes}, kept}`.
  `songs` = the account's library rows; `removable` = the files a "con sus canciones"
  delete would remove; `kept = songs − removable.count`. Pure read.
- **Changed, additive** `DELETE /api/users/{user_id}`: optional query `songs=true`
  (default false). Every delete now also removes the account's library rows
  (`user_tracks.json`). `songs=false` → its playlists pass to the caller.
  `songs=true` → its removable files are deleted (with their `.lrc`/`.txt` sidecars,
  stems and lyrics index entries — the same path `POST /api/delete-track` takes) and
  its playlists are deleted. Answer keeps `{success, user}` and adds
  `{removedSongs, freedBytes, playlists: "transferred" | "deleted"}`.
  404 unknown · 422 last admin (unchanged).
- **Removable** = a row of that account with `acquired: true` whose `relPath` no other
  real account holds a row for, and whose file exists. `acquired` is a new field on
  `user_tracks` rows, set to `true` only when the row is created by linking a finished
  download made by that account (browse acquire, the download routes, playlist
  imports); a found-on-the-nest hit, a manual add and every row written before this
  change read as `false`. Never exposed in `/api/me/library`.

## States and controls

| when | the dialog shows | tapping it does |
|---|---|---|
| opened, preview pending | facts line with "…"; both options, numbers as skeletons; "Only the account" selected | — |
| preview answered, `removable.count > 0` | both options with numbers; bar = removable / songs | selecting an option changes the danger button's label |
| preview answered, `removable.count == 0` | "Con sus canciones" disabled, legend "0 songs only theirs", tooltip says why | — |
| preview failed | "Con sus canciones" disabled with "—" and the reason; "Retry" | refetches the preview |
| deleting | both buttons disabled, danger button "Deleting…" | — |
| done | dialog closes, row gone, toast with what happened | — |
| last admin (422) | "Your account cannot be deleted" + reason, one "Got it" | closes |
| own account | title "Delete your account?"; same choices; after deleting, this device signs out (unchanged behaviour) | — |

The selected option is always "Only the account" when the dialog opens.

## Copy (exact strings)

| where | text |
|---|---|
| title (other) / (own) | "Delete {{name}}’s account?" / "Delete your account?" |
| facts line | `facts` in the contract: "{{d}} dispositivos · {{s}} canciones · {{p}} listas", singulars "1 dispositivo", "1 canción", "1 lista" |
| option A | "Only the account" · legend "{{n}} canciones se quedan en el server" · "{{p}} listas pasan a ti" |
| option B | "The account and its songs" · legend "{{n}} se borran · {{size}}" · "{{k}} se quedan · otras cuentas las tienen" · "{{p}} listas se borran" |
| singulars (count 1) | "1 canción se queda en el server" · "1 lista pasa a ti" · "1 se borra · {{size}}" · "1 se queda · otra cuenta la tiene" · "1 lista se borra" |
| option B tooltip | "Solo se borran del server las canciones que {{name}} descargó y que ninguna otra cuenta guardó. Las demás se quedan." |
| option B disabled (none) | legend "0 songs only theirs" · tooltip "{{name}} no descargó ninguna canción que solo tenga en el server." |
| option B disabled (error) | "El server no respondió · sin saber cuáles son solo suyas no se borra ninguna" · button "Retry" |
| cancel | "Dejarla" |
| danger button | `doLabel` in the contract: "Delete account" / "Eliminar cuenta y {{n}} canciones" ("… y 1 canción") |
| busy | "Deleting…" |
| success toast | "{{name}}’s account deleted" + (songs) " · {{n}} canciones borradas · {{size}} libres" |
| last admin | "Your account cannot be deleted" / "It is the nest’s last admin account: without it, nobody could create or remove accounts." / "Got it" |

Sizes: `size` in the contract — decimal units, the language's comma ("1,2 GB", "850 MB"),
same as Settings' `formatBytes`. Roles in lists stay "Admin" / "Standard" (`one-account.json`).

## Decided per app on purpose

Desktop: centred dialog (modern island). Phones: bottom sheet, buttons stacked, danger
first. Option icons are optional on phones. Everything else matches.

## Pinned by

`contracts/delete-account.json` — `facts`, `doLabel`, `optionB` (enabled or why not),
`size`, `toast`. `contracts/wire/deletion-preview.json` and `contracts/wire/delete-user.json`.

## Not in scope

Undo (deleting is final, which is why it asks). Deleting songs for an account that
predates provenance (its rows read `acquired: false`). Bulk deletion.
