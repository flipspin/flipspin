/* krobi-ui; AGPL-3.0; see LICENSE. */
import i18n, { msg } from "../../../i18n";

/**
 * The closed vocabulary for a value that isn't there. Every word says why at
 * a glance (the tooltip is a bonus, not the only explanation); never a bare
 * "—". An *optional* fact that is absent (a year, a genre on a details) is left
 * out instead of shown with a word.
 */
export const MISSING = {
  deleted: { word: msg("Deleted"), reason: msg("Not in your library anymore") },
  untagged: { word: msg("Not tagged"), reason: msg("The file's tags don't include it") },
  unanalysed: { word: msg("Not analyzed"), reason: msg("Not analysed yet") },
  unmeasured: { word: msg("Not measured"), reason: msg("Not measured yet") },
  unverified: { word: msg("Not checked"), reason: msg("Not checked yet") },
  never: { word: msg("Never"), reason: msg("Hasn't happened yet") },
  noAccount: { word: msg("No account"), reason: msg("This credential has no account of its own in this nest.") },
  nodata: { word: msg("No data"), reason: msg("The nest didn't send this") },
  unavailable: { word: msg("Unavailable"), reason: msg("Can't be read here") },
  connecting: { word: msg("Connecting…"), reason: msg("Waiting for the nest") },
  loading: { word: msg("Loading…"), reason: msg("Asking for it") },
  noAccess: { word: msg("No access"), reason: msg("Your account can't see this") },
  noTitle: { word: msg("Untitled"), reason: msg("The file's tags don't include it") },
  noArtist: { word: msg("No artist"), reason: msg("The file's tags don't include it") },
  noAlbum: { word: msg("No album"), reason: msg("The file's tags don't include it") },
  notSet: { word: msg("Not set"), reason: msg("Not configured yet") },
} as const;

export type MissingKind = keyof typeof MISSING;

/** The word, translated now; for places that need a string (a prop, a title, a join). */
export function missingWord(kind: MissingKind): string {
  return i18n.t(MISSING[kind].word);
}
