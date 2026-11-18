# one-account — one account, many devices; no "casa" (house), "familia" (family) or "miembro" (member) in user-facing text

## What it does

A Flipspin nest is used by one account from all of that person's devices. Nothing a
person reads talks about a house, a family, members or people any more. Several
accounts are still possible and the "Accounts" (Accounts) pane stays, reworded:
it lists the nest's accounts, and their roles are **"Admin"** and **"Standard"** (Standard).

## Server

None. Routes, roles (`owner` / `member`), `/api/users`, per-account libraries and
playlist owners are unchanged. Only the words change.

## States and controls

| when | shows |
|---|---|
| an account's role is `owner` | "Admin" |
| an account's role is `member` | "Standard" |
| the "Accounts" pane | unchanged structure; every sentence below uses "account" (account), never "persona" (person) |

## Spanish source keys and English copy

| Before | After (Spanish) | After (English) |
|---|---|---|
| "¿Quitar a "{{name}}" de la casa? Pierde el acceso de inmediato, con todos sus dispositivos, y no se puede deshacer." | "¿Eliminar la cuenta "{{name}}"? Pierde el acceso de inmediato en todos sus dispositivos, y no se puede deshacer." | Delete the account “{{name}}”? It loses access immediately on all its devices, and it can't be undone. |
| "Además, es la única cuenta de admin: el nido rechazará eliminarla para que nadie se quede sin poder administrar la casa." | "Además, es la única cuenta admin: el nido no la eliminará, para que siempre haya una cuenta que lo administre." | It's also the only admin account: the nest won't delete it, so there's always an account that can manage it. |
| "Crea una <1>cuenta nueva</1>: esa persona verá la música de la casa, pero sus listas y lo que marque serán suyos y no aparecerán en los tuyos." | "Crea una <1>cuenta aparte</1>: verá la misma música del nido, pero sus listas y lo que guarde no se mezclan con los tuyos." | Create a <1>separate account</1>: it sees the same music in the nest, but its playlists and what it saves don't mix with yours. |
| "En la casa:" | "En el nido:" | In the nest: |
| "Es el último admin. Si se le quita el acceso, nadie podría volver a administrar esta casa: haz admin a otra persona primero." | "Es la última cuenta admin. Si se elimina, nadie podría volver a administrar este nido: haz admin otra cuenta primero." | It's the last admin account. If it's deleted, nobody could manage this nest again: make another account an admin first. |
| "Esta cuenta es de miembro y no puede añadir gente a la casa." | "Esta cuenta no es admin y no puede crear cuentas." | This account isn't an admin and can't create accounts. |
| "Esta cuenta es de miembro y no puede quitar a nadie de la casa." | "Esta cuenta no es admin y no puede eliminar cuentas." | This account isn't an admin and can't delete accounts. |
| "Esta cuenta es de miembro y solo puede cambiar su propio nombre." | "Esta cuenta no es admin y solo puede cambiar su propio nombre." | This account isn't an admin and can only change its own name. |
| "Esta cuenta es de miembro, así que no puede ver los dispositivos de nadie más." | "Esta cuenta no es admin y no puede ver los dispositivos de otras cuentas." | This account isn't an admin and can't see other accounts' devices. |
| "Esta cuenta es de miembro, así que no puede ver quién más tiene acceso. Sí hay más gente en esta casa: la lista se administra desde una cuenta de admin." | "Esta cuenta no es admin y no puede ver las demás cuentas del nido. Se administran desde una cuenta admin." | This account isn't an admin and can't see the nest's other accounts. They're managed from an admin account. |
| "Este equipo entra sin una cuenta propia (porque es el propio nido, o con la clave compartida de la casa), así que no hay ninguna lista de dispositivos que enseñar. Inicia sesión con una cuenta para tener dispositivos tuyos." | "Este equipo entra sin una cuenta propia (porque es el propio nido, o con la clave compartida del nido), así que no hay ninguna lista de dispositivos que enseñar. Inicia sesión con una cuenta para tener dispositivos tuyos." | This device signs in without an account of its own (because it is the nest itself, or with the nest's shared key), so there's no device list to show. Sign in with an account to have devices of your own. |
| "Este equipo no es una Mac con Apple Silicon; otra Mac de la casa tendrá que procesar." | "Este equipo no es una Mac con Apple Silicon; otra Mac de tu red tendrá que procesar." | This computer isn't an Apple Silicon Mac; another Mac on your network will have to process. |
| "Este nido es nuevo. La primera cuenta será la dueña del nido, y sus datos vivirán en {{dataDir}}." | "Este nido es nuevo y guardará sus datos en {{dataDir}}." | This nest is new and will keep its data in {{dataDir}}. |
| "Este nido es nuevo. La primera cuenta será la dueña del nido." | "Este nido es nuevo." | This nest is new. |
| "Funciona igual para escuchar la música de la casa, pero lo que marques o escuches no se guarda a nombre de nadie, y no hay contraseña que cambiar ni dispositivos que administrar." | "Funciona igual para escuchar la música del nido, pero lo que marques o escuches no se guarda en ninguna cuenta, y no hay contraseña que cambiar ni dispositivos que administrar." | It works the same for listening to the nest's music, but what you mark or listen to isn't saved to any account, and there's no password to change or devices to manage. |
| "La creó otra persona de la casa" | "La creó otra cuenta" | Another account created it |
| "Miembro" | "Normal" | Standard |
| "Nombre en la casa" | "Nombre de la cuenta" | Account name |
| "Puede administrar quién entra en esta casa." | "Puede crear y eliminar cuentas y dispositivos." | Can create and delete accounts and devices. |
| "Quitar a "{{name}}" de la casa" | "Eliminar la cuenta "{{name}}"" | Delete the account “{{name}}” |
| "Solo quien administra el nido puede cambiarle el nombre." | "Solo una cuenta admin puede cambiarle el nombre." | Only an admin account can rename it. |
| "Todavía no hay nadie más en esta casa." | "Todavía no hay otras cuentas en este nido." | There are no other accounts in this nest yet. |
| "Trae música a tu nido. Lo que importes queda en la biblioteca de la casa, disponible desde el móvil y desde cualquier equipo que se conecte a él." | "Trae música a tu nido. Lo que importes queda en su biblioteca, disponible desde todos tus dispositivos." | Bring music to your nest. Whatever you import stays in its library, available from all your devices. |
| "Tu nido guarda tu música, tus listas y las cuentas de tu casa." | "Tu nido guarda tu música, tus listas y tus dispositivos." | Your nest keeps your music, your playlists and your devices. |
| "Ve la biblioteca de la casa y tiene sus propias listas." | "Ve la biblioteca del nido y tiene sus propias listas." | Sees the nest's library and has its own playlists. |
| "Ve la biblioteca y sus propias listas. No puede añadir ni revocar dispositivos. Es lo que quieres para el teléfono de alguien de la casa." | "Ve la biblioteca y sus propias listas. No puede añadir ni revocar dispositivos." | Sees the library and its own playlists. Can't add or revoke devices. |
| "Ya hay un nido en tu casa: conéctate a él." | "Ya hay un nido en tu red: conéctate a él." | There's already a nest on your network: join it. |
| "Ya hay una lista con ese nombre en la casa. Los nombres no se repiten aunque sean de personas distintas." | "Ya hay una lista con ese nombre en el nido. Los nombres no se repiten aunque sean de cuentas distintas." | There's already a playlist with that name in the nest. Names aren't repeated even across different accounts. |
| "Esa lista es de otra persona. Pídele que te la comparta, o haz una copia con otro nombre." | "Esa lista es de otra cuenta del nido. Haz una copia con otro nombre." | That playlist belongs to another account in the nest. Make a copy with a different name. |
| "De otra persona" | "De otra cuenta" | Another account's |
| "Alguien ya creó la primera cuenta en este nido. Pídele acceso, o inicia sesión." | "Este nido ya tiene una cuenta. Inicia sesión con ella." | This nest already has an account. Sign in with it. |
| "Cada cuenta es una persona con su propia biblioteca y sus propias listas. Abre una para ver sus dispositivos." | "Cada cuenta tiene su propia biblioteca y sus propias listas. Abre una para ver sus dispositivos." | Each account has its own library and its own playlists. Open one to see its devices. |
| "Esa persona ya no estaba en el nido. Actualiza la lista." | "Esa cuenta ya no estaba en el nido. Actualiza la lista." | That account was no longer in the nest. Refresh the list. |
| "La cuenta se creó pero el nido no devolvió el código, y ya no se puede recuperar. Elimina a esa persona de la lista y vuelve a crearla." | "La cuenta se creó pero el nido no devolvió el código, y ya no se puede recuperar. Elimina esa cuenta de la lista y vuelve a crearla." | The account was created but the nest didn't return its code, and it can't be recovered. Delete that account from the list and create it again. |
| "No se pudo hablar con tu nido. Esa persona sigue teniendo acceso." | "No se pudo hablar con tu nido. Esa cuenta sigue teniendo acceso." | Couldn't reach your nest. That account still has access. |
| "No se pudo quitar a esa persona." | "No se pudo eliminar esa cuenta." | Couldn't delete that account. |
| "Nombre de la persona" | "Nombre de la cuenta" | Account name |
| "Personas con cuenta en este nido" | "Cuentas en este nido" | Accounts in this nest |

The phones have their own strings for the same screens. Each app rewrites its
own copy to the same rule: "cuenta" or "dispositivo" (device) where it said person,
member, family or household; "nido" (nest) or "tu red" (your network) where it said "casa".

## Decided per app on purpose

Each app's own sentences may differ in wording, as long as none uses a word from
`contracts/one-account.json` → `forbidden` and the role labels match `roleLabel`.

## Pinned by

`contracts/one-account.json` — forbidden words, the allowed phrases, and the two
role labels. The renderer reads it in `renderer/src/settings/oneAccount.test.ts`.

## Not in scope

Renaming code identifiers (`HouseholdSection`, the `casa` section id, `owner` /
`member`), removing multiple accounts (option B), and the app name (still
`Flipspin` in `APP_NAME`).
