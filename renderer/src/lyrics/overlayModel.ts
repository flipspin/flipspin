import type { PlaybackPort } from '../player/engine/PlaybackPort';
// Pure pieces of the full-screen lyrics view (`LyricsOverlay`): the shapes it
// reads off the player context, the per-machine look preferences, the sync
// nudge's step ladder and the track facts the right rail shows.
import type { RefObject } from "react";
import type { TFunction } from "i18next";
import { buildCoverImageUrl, parseTrackPath } from "@lib/api";
import { applyLyricOffset, type LyricLine } from "./lrc";

export interface LyricsTrack {
  path?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | { name?: string | null; album?: string | null; cover?: string | null } | null;
  albumCover?: string | null;
  bpm?: string | number | null;
  key?: string | null;
  genre?: string | null;
  mood?: string | null;
  analysis?: { camelot?: string | null } | null;
}

/** The slice of `useAudioPlayer()` the lyrics view reads (the context itself is untyped). */
export interface AudioPlayerValue {
  audioRef: RefObject<PlaybackPort | null>;
  nowPlaying: LyricsTrack | null;
  selectedTrack: LyricsTrack | null;
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  shuffleEnabled: boolean;
  toggleShuffle: () => void;
  goNext?: () => void;
  goPrevious?: () => void;
  queue?: unknown[];
}

export interface AudioProgressValue {
  progress: number;
  duration: number;
  setProgress: (seconds: number) => void;
}

/** The playhead granularity the lyric view re-renders at. */
export const LYRICS_TICK_S = 0.1;

/** How far one press of − / + moves the lyric; holding speeds up after one second. */
export const NUDGE_S = 0.1;
export const HOLD_DELAY_MS = 400;
export const HOLD_REPEAT_MS = 80;
export const SAVE_AFTER_MS = 300;

/** Two per-machine looks, remembered: the artwork backdrop or a plain ground. */
export const BACKDROP_KEY = "krobi.lyricsBackdrop";
export const WAVE_KEY = "krobi.lyricsWaveOpen";

export function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a private window; the choice lasts the session */
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The sync button's caption: LRC's `[offset:]` sign with a typographic minus. */
export function formatOffset(seconds: number): string {
  const sign = seconds > 0 ? "+" : seconds < 0 ? "−" : "";
  return `${sign}${Math.abs(seconds).toFixed(1)} s`;
}

/** What the field typed parses to ("1,5", "−0.3"), or null when it is not a number. */
export function parseOffsetDraft(draft: string): number | null {
  const n = Number(String(draft).replace(",", ".").replace("−", "-"));
  return Number.isFinite(n) ? round2(n) : null;
}

/** The lines with a not-yet-saved offset applied to every stamp (never below 0). */
export function offsetLines(lines: LyricLine[], offset: number): LyricLine[] {
  if (offset === 0) return lines;
  return lines.map((l) => (l.time === null ? l : { ...l, time: applyLyricOffset(l.time, offset * 1000) }));
}

/** The sync popover's foot for a save state, or null when there is nothing to say. */
export function syncFootText(saveState: string, t: TFunction): string | null {
  switch (saveState) {
    case "local": return t("Saved on this device · pending sync");
    case "syncing": return t("Syncing with the server…");
    case "conflict": return t("Server changes found · check Settings → Lyrics");
    case "blocked": return t("Sync stopped · check Settings → Lyrics");
    case "saving": return t("Saving…");
    case "saved": return t("Saved into the lyrics file");
    case "error": return t("The offset could not be saved");
    default: return null;
  }
}

export function coverOf(track: LyricsTrack | null): string | null {
  if (!track) return null;
  const albumObj = track.album && typeof track.album === "object" ? track.album : null;
  if (albumObj?.cover) return albumObj.cover;
  if (track.albumCover) return track.albumCover;
  const { albumName } = parseTrackPath(track.path || "");
  return albumName ? buildCoverImageUrl(albumName) : null;
}

export function albumOf(track: LyricsTrack | null): string {
  if (!track) return "";
  return typeof track.album === "object" ? track.album?.name || track.album?.album || "" : track.album || "";
}

/** A positive tempo, rounded, or null for a missing / unparseable one. */
export function bpmOf(track: LyricsTrack | null): number | null {
  const n = Number(track?.bpm);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Camelot when the analysis has it, else the tag's key. */
export function keyOf(track: LyricsTrack | null): string | null {
  return track?.analysis?.camelot || track?.key || null;
}
