import type { PlayHistory } from "@lib/playHistory";
import type { ListedAlbum, ListedTrack } from "./decorateTrack";

/** Pure view data. Original tracks/albums are retained for the shared player decorator. */
export type LibrarySong = {
  track: ListedTrack;
  album: ListedAlbum;
  bpm: number | null;
  energy: number | null;
  camelot: string | null;
  mood: string;
  duration: number;
};
export type SongBucket = { id: string; songs: LibrarySong[] };
export type ListeningBucket = SongBucket & { plays: number; seconds: number; albums: ListedAlbum[] };

const finite = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

// Clockwise Camelot ordering; conventional key names are accepted when no code exists.
const MAJOR = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"];
const MINOR = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const ENHARMONIC: Record<string, string> = { "G#": "Ab", "D#": "Eb", "A#": "Bb", "Gb": "F#", "C#": "Db" };
export const CAMELOT_CODES = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();

export function camelotCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^(?:[1-9]|1[0-2])[AB]$/i.test(text)) return text.toUpperCase();
  const match = text.match(/^([A-Ga-g])([#b♯♭]?)(?:\s*(major|minor|maj|min|m))?$/);
  if (!match) return null;
  const note = match[1].toUpperCase() + match[2].replace("♯", "#").replace("♭", "b");
  const minor = ["minor", "min", "m"].includes(match[3]);
  const names = minor ? MINOR : MAJOR;
  let index = names.indexOf(note);
  if (index < 0) {
    const equivalent = ENHARMONIC[note] ?? Object.entries(ENHARMONIC).find(([, v]) => v === note)?.[0];
    index = names.indexOf(equivalent);
  }
  return index < 0 ? null : `${index + 1}${minor ? "A" : "B"}`;
}

export function camelotNeighbours(code: string): string[] {
  if (!/^(?:[1-9]|1[0-2])[AB]$/.test(code)) return [];
  const n = Number(code.slice(0, -1));
  const ring = code.slice(-1);
  return [`${n === 1 ? 12 : n - 1}${ring}`, `${n === 12 ? 1 : n + 1}${ring}`, `${n}${ring === "A" ? "B" : "A"}`];
}

export function librarySongs(albums: readonly ListedAlbum[]): LibrarySong[] {
  const seen = new Set<string>();
  return albums.flatMap(album => (album.tracks ?? []).flatMap(track => {
    if (!track.path || seen.has(track.path)) return [];
    seen.add(track.path);
    const analysis = record(track.analysis);
    const bpm = finite(track.bpm);
    const energy = finite(analysis.energy);
    return [{ track, album, bpm: bpm !== null && bpm > 0 ? bpm : null,
      energy: energy !== null && energy >= 0 && energy <= 1 ? energy : null,
      camelot: camelotCode(track.key) ?? (track.analysisState === undefined ? camelotCode(analysis.camelot) : null),
      mood: typeof track.mood === "string" ? track.mood.trim().toLowerCase() : "",
      duration: Math.max(0, finite(track.duration) ?? 0) }];
  }));
}

export function bpmBuckets(songs: readonly LibrarySong[]): SongBucket[] {
  return Array.from({ length: 13 }, (_, i) => {
    const start = 60 + i * 10;
    return { id: `${start}–${start + 10}`, songs: songs.filter(s => s.bpm !== null && s.bpm >= start && (s.bpm < start + 10 || (i === 12 && s.bpm === 190))) };
  });
}

export function keyBuckets(songs: readonly LibrarySong[]): SongBucket[] {
  return CAMELOT_CODES.map(id => ({ id, songs: songs.filter(s => s.camelot === id) }));
}

export function harmonicSongs(songs: readonly LibrarySong[], code: string): LibrarySong[] {
  const keys = new Set([code, ...camelotNeighbours(code)]);
  return songs.filter(s => s.camelot !== null && keys.has(s.camelot));
}

function grouped(songs: readonly LibrarySong[], keys: (song: LibrarySong) => string[]): { buckets: SongBucket[]; missing: number } {
  const map = new Map<string, LibrarySong[]>();
  let missing = 0;
  for (const song of songs) {
    const ids = [...new Set(keys(song))];
    if (!ids.length) missing++;
    for (const id of ids) {
      const bucket = map.get(id) ?? [];
      bucket.push(song);
      map.set(id, bucket);
    }
  }
  return { buckets: [...map].map(([id, tracks]) => ({ id, songs: tracks })), missing };
}

export function decadeBuckets(songs: readonly LibrarySong[]) {
  const result = grouped(songs, song => {
    const year = finite(song.album.year);
    return year !== null && year >= 1000 && year <= 9999 ? [String(Math.floor(year / 10) * 10)] : [];
  });
  result.buckets.sort((a, b) => Number(a.id) - Number(b.id));
  return result;
}

export function genreBuckets(songs: readonly LibrarySong[]) {
  const genres = (value: unknown): string[] =>
    (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;/]/) : [])
      .filter((s): s is string => typeof s === "string").map(s => s.trim()).filter(Boolean);
  const result = grouped(songs, song => {
    const own = genres(song.track.genre);
    return own.length ? own : genres(song.album.genre);
  });
  result.buckets.sort((a, b) => b.songs.length - a.songs.length || a.id.localeCompare(b.id));
  return result;
}

export function moodBuckets(songs: readonly LibrarySong[]): SongBucket[] {
  return grouped(songs, s => s.mood ? [s.mood] : []).buckets
    .sort((a, b) => b.songs.length - a.songs.length || a.id.localeCompare(b.id));
}

export function listeningBuckets(songs: readonly LibrarySong[], history: PlayHistory) {
  const map = new Map<string, ListeningBucket>();
  const artistAlbums = new Map<string, Set<ListedAlbum>>();
  for (const song of songs) {
    const artist = song.track.artist?.trim() || song.album.artist?.trim() || "";
    const albums = artistAlbums.get(artist) ?? new Set<ListedAlbum>();
    albums.add(song.album);
    artistAlbums.set(artist, albums);
  }
  for (const song of songs) {
    const n = finite(history[song.track.path]?.n);
    if (n === null || n <= 0) continue;
    const plays = Math.floor(n);
    if (!plays) continue;
    const id = song.track.artist?.trim() || song.album.artist?.trim() || "";
    const bucket = map.get(id) ?? { id, songs: [], plays: 0, seconds: 0, albums: [...(artistAlbums.get(id) ?? [])] };
    bucket.songs.push(song);
    bucket.plays += plays;
    bucket.seconds += plays * song.duration;
    map.set(id, bucket);
  }
  const buckets = [...map.values()].sort((a, b) => b.plays - a.plays || a.id.localeCompare(b.id));
  return { buckets, plays: buckets.reduce((n, b) => n + b.plays, 0), hours: buckets.reduce((n, b) => n + b.seconds, 0) / 3600 };
}

export function fullest(buckets: readonly SongBucket[]): string {
  return [...buckets].sort((a, b) => b.songs.length - a.songs.length)[0]?.id ?? "";
}
