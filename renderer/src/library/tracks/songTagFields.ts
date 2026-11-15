import { msg } from '../../i18n';
import type { TagValue } from "./songTags";

export const FIELDS = [
  ["title", msg("Title")], ["artist", msg("Artist")], ["albumArtist", msg("Album artist")],
  ["album", msg("Album")], ["genre", msg("Genre")], ["year", msg("Year")],
  ["trackNumber", msg("Track number")], ["trackTotal", msg("Track total")],
  ["discNumber", msg("Disc number")], ["discTotal", msg("Disc total")], ["compilation", msg("Compilation")],
] as const;
export const FIELD_GROUPS = [...FIELDS.slice(0, 5).map(field => [field]), FIELDS.slice(5, 10), [FIELDS[10]]];
export type Field = typeof FIELDS[number][0];
export const NUMBERS = new Set<Field>(["year", "trackNumber", "trackTotal", "discNumber", "discTotal"]);

export const tagText = (value: TagValue | undefined) => value == null ? "" : Array.isArray(value) ? value.join("; ") : String(value);
export function tagValue(field: Field, value: string): TagValue {
  const next = value.trim();
  return next === "" ? null : field === "compilation" ? next === "true" : NUMBERS.has(field) ? Number(next) : next;
}
