/**
 * Words about where a lyric came from, shared by the overlay's rail and the
 * modal's "already has lyrics" line so the two never disagree.
 */
import type { TFunction } from "i18next";
import type { LyricsDoc } from "./lyricsStore";

export function sourceLabel(doc: Pick<LyricsDoc, "source" | "kind">, t: TFunction) {
  const names: Record<string, string> = { lrclib: "LRCLIB", genius: "Genius", musixmatch: "Musixmatch", file: t(".lrc file"), manual: t("written by hand") };
  const base = String(doc.source || "");
  const name = base.startsWith("stt:") ? t("transcribed on another computer") : names[base] || base;
  const kind = doc.kind === "synced" ? t("synced") : doc.kind === "plain" ? t("text only") : t("instrumental");
  return `${name} · ${kind}`;
}

export { enginePhase } from './phase'

/** Source vocabulary shared by the window and sync panel. */
export function lyricSource(source: string, t: TFunction) {
  const names: Record<string, string> = { lrclib: t("LRCLIB"), genius: t("Genius"), lyricsovh: t("Lyrics.ovh"), manual: t("Your text"), file: t("File beside the song") };
  return names[source] || t("Your text");
}
