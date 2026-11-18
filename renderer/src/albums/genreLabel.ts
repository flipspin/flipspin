import english from "./genres.en.json";

/** The server writes Spanish genre tags. Map known Deezer names by genre id
 * and leave unknown or user-written tags unchanged. */
const EN = english as Record<string, string>;

export function genreLabel(value: string | string[] | null | undefined, language: string | undefined): string {
  const parts = (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  const english = (language || "").toLowerCase().startsWith("en");
  return parts.map((p) => (english ? EN[p] ?? p : p)).join(", ");
}
