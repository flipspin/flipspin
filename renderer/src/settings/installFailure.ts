/** Words for a failed source install, keyed by the server's cause codes (contracts/source-plugin.json installFailureCauses). */
import { msg } from '../i18n'

export const INSTALL_FAILURE_CAUSE: Record<string, string> = {
  'no-network': msg("The nest has no internet connection."),
  'not-found': msg("The plugin wasn't found at its address."),
  'too-large': msg("The download is too large."),
  'bad-archive': msg("The download is damaged."),
  'tool-missing': msg("A tool the plugin needs is missing on the nest."),
  'tool-failed': msg("A tool the plugin needs stopped with an error."),
  timeout: msg("It took too long."),
  'build-failed': msg("The plugin couldn't be set up."),
  unsupported: msg("This plugin doesn't support this nest."),
  'invalid-manifest': msg("The plugin's description is invalid."),
  'id-in-use': msg("Another plugin already uses this name."),
  handshake: msg("The plugin didn't answer when started."),
  'test-failed': msg("The plugin failed its first check."),
  space: msg("The nest is out of space."),
  cancelled: msg("The install was cancelled."),
  unknown: msg("Something went wrong."),
}

/** The msg() key for a cause; unknown or missing codes fall back to the generic line. */
export function installFailureKey(cause: string | null | undefined): string {
  return (cause && INSTALL_FAILURE_CAUSE[cause]) || INSTALL_FAILURE_CAUSE.unknown
}
