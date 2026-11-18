/**
 * Maps settings protocol codes and HTTP failures to localized UI messages.
 * Translate machine outcomes here; never render backend detail strings as interface copy.
 * Static records contain msg() keys translated by the render site.
 * Functions translate at invocation time so language changes remain effective.
 * No message takes or interpolates a credential.
 */

import type { ServerProblem } from '../lib/ipc'

import { isApiError } from '../data'
import i18n, { msg } from '../i18n'

/** Include address checks when switching servers: the current connection remains usable if the new probe fails. */
export const PROBE_FAILURE: Record<string, string> = {
  unreachable: msg(
    "Nothing answered at that address. Check that the machine is on and on this network, and that the address is spelled right. You're still connected to the previous nest.",
  ),
  'not-our-server': msg(
    "There's something there, but it isn't a {{app}} nest. If that machine runs several services, check the port.",
  ),
  redirected: msg(
    "That address redirects somewhere else, so it can't be trusted. Type the nest's direct address.",
  ),
  'insecure-downgrade': msg(
    "You asked for https and the nest answered unencrypted. It won't connect that way: change the address to http:// if that's really what you want.",
  ),
  'invalid-address': msg("That address does not parse. Try something like my-nest:8000."),
}

export const PROBE_FAILURE_UNKNOWN = msg(
  "That address couldn't be checked. Your current nest hasn't changed.",
)

/** Name a conflicting library explicitly so a refused startup cannot look like a generic connection failure. */
export const SERVER_PROBLEM: Record<ServerProblem, string> = {
  'occupied-by-other': msg(
    "Another nest with a different library is already using {{app}}’s port. Close that program or enter its address below to connect to it.",
  ),
  'port-busy': msg(
    "Another program uses the port {{app}} needs. Close it and reopen the app, or connect to a nest on your network.",
  ),
  'start-failed': msg(
    "Your nest never started. Quit {{app}} and open it again; if it still fails, the cause is usually in the last lines of its log, in Krobi/logs inside your home folder.",
  ),
  'not-installed': msg(
    "This version does not include a nest. Enter your nest’s address.",
  ),
}

/** The HTTP status, when the failure carries one. `null` for everything else. */
export function statusOf(error: unknown): number | null {
  return isApiError(error) ? error.status : null
}

/** Distinguish an older server's stock 404 from a removed account.
 * The former needs an update; the latter is resolved by refreshing the account list. */
export function accountDevicesFailure(error: unknown): { text: string; fact: boolean } {
  switch (statusOf(error)) {
    case 404:
      return isStockNotFound(error)
        ? { fact: true, text: i18n.t("This nest doesn't show other accounts' devices yet.") }
        : { fact: true, text: i18n.t("That account is no longer in the nest. Refresh the list.") }
    case 403:
      return { fact: true, text: i18n.t("Only an admin account can see other accounts’ devices.") }
    case 401:
      return { fact: true, text: i18n.t("This device no longer has access to your nest. Sign in again._computer") }
    case null:
      return { fact: false, text: i18n.t("Couldn't reach your nest. Check that it's still on.") }
    default:
      return { fact: false, text: i18n.t("This account's devices couldn't be fetched.") }
  }
}

/** FastAPI's answer for a path it has no route for; an older server, not a missing account. */
function isStockNotFound(error: unknown): boolean {
  if (!isApiError(error) || typeof error.body !== 'object' || error.body === null) return false
  return (error.body as { detail?: unknown }).detail === 'Not Found'
}
