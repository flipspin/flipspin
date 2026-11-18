/** Share failure copy so lists and dialogs describe the same problem consistently.
 * Translate msg() keys at render time. These helpers must never receive a token. */

import i18n, { msg } from '../i18n'
import type { PairingFailureKind, Role } from './types'

export const ROLE_NAMES: Record<Role, string> = {
  owner: msg('Admin'),
  member: msg("Standard"),
}

/** Name each role's access-management powers so the choice makes its consequence clear. */
export const ROLE_EXPLANATIONS: Record<Role, string> = {
  member:
    msg("Sees the library and its own playlists. Can't add or revoke devices."),
  owner:
    msg("Can add and revoke devices, including this computer. Give it only to a device of your own."),
}

/**
 * The default, and it is a safety decision, not a convenience one. A phone
 * paired as owner can revoke the owner's own access, and the person doing
 * the pairing is usually thinking about music, not about permissions.
 */
export const DEFAULT_ROLE: Role = 'member'

/** A device has no lastSeenAt until its token is used. Translate the absent word at call time. */
export function formatMoment(iso: string | null, absent?: string): string {
  if (iso === null || iso === '') return absent ?? i18n.t("Never")
  const moment = new Date(iso)
  if (Number.isNaN(moment.getTime())) return iso
  return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(moment)
}

/** A refused listing must not imply that no devices have access. */
export function listFailureText(kind: PairingFailureKind): string {
  switch (kind) {
    case 'forbidden':
      return i18n.t("Only an admin account can view and manage devices.")
    case 'unreachable':
      return i18n.t("Couldn't reach your nest. Check the address and that it's on.")
    default:
      return i18n.t("Your nest answered something this version can't read.")
  }
}

export function mintFailureText(kind: PairingFailureKind): string {
  switch (kind) {
    case 'forbidden':
      return i18n.t("Only an admin account can link devices.")
    case 'rejected':
      return i18n.t("Your nest rejected the name or the permission. Try a shorter name.")
    case 'malformed':
      return i18n.t("The access was created but the nest didn't return the token, and it can't be recovered now. Revoke that device in the list and create it again.")
    case 'unreachable':
      return i18n.t("Couldn't reach your nest. No access was created.")
    default:
      return i18n.t("The access couldn't be created.")
  }
}

export function revokeFailureText(kind: PairingFailureKind): string {
  switch (kind) {
    case 'forbidden':
      return i18n.t("Only an admin account can remove access.")
    case 'missing':
      return i18n.t("That device is no longer in the nest. Refresh the list.")
    case 'lastOwner':
      return i18n.t("It is the last admin. Without it, nobody could manage access.")
    case 'unreachable':
      return i18n.t("Couldn't reach your nest. The device still has access.")
    default:
      return i18n.t("The access couldn't be revoked.")
  }
}
