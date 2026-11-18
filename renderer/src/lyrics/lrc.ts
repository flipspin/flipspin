/**
 * LRC in, lines out. Standard `[mm:ss.xx]` (one or several stamps per line),
 * optional enhanced `<mm:ss.xx>` word tags stripped from the text, and the
 * `[ti:]`/`[ar:]`/`[offset:]` header tags honoured or ignored as they should
 * be. Plain text parses too; every line untimed; so one renderer serves both.
 */

export interface LyricLine {
  /** Seconds from the start, or null for an untimed (plain) line. */
  time: number | null;
  text: string;
}

const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const META = /^\[(ti|ar|al|au|by|re|ve|length|offset):(.*)\]$/i;
const WORD_TAG = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;

function stampToSeconds(min: string, sec: string, frac: string | undefined): number {
  const fraction = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(min) * 60 + Number(sec) + fraction;
}

export function parseLyrics(text: string | null | undefined, overrideOffsetMs?: number): LyricLine[] {
  if (!text) return [];
  const offsetMs = overrideOffsetMs ?? readLyricsOffset(text);
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const meta = line.trim().match(META);
    if (meta) {
      continue;
    }
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    STAMP.lastIndex = 0;
    while ((match = STAMP.exec(line)) !== null) {
      stamps.push(stampToSeconds(match[1], match[2], match[3]));
    }
    const body = line.replace(STAMP, "").replace(WORD_TAG, "").trim();
    if (stamps.length === 0) {
      lines.push({ time: null, text: body });
      continue;
    }
    for (const stamp of stamps) {
      lines.push({ time: stamp, text: body });
    }
  }
  const timed = lines.filter((l) => l.time !== null);
  if (timed.length === 0) return lines;
  // A repeated chorus written as `[00:40][01:50] text` unfolds out of order.
  return lines
    .filter((l) => l.time !== null)
    .sort((a, b) => (a.time as number) - (b.time as number))
    // Keep the same line order when several corrected stamps clamp to zero,
    // so a picked index still identifies its original stamp.
    .map(line => ({ ...line, time: applyLyricOffset(line.time as number, offsetMs) }));
}

/** Legacy timestamp shifting, retained for explicit text workflows. */
export function shiftLyrics(text: string, seconds: number): string {
  if (!text || !seconds) return text;
  const precision = Math.min(3, (String(seconds).split(".")[1] || "").length);
  return text.replace(SHIFTABLE, (_, open, min, sec, sep, frac, close) => {
    const digits = Math.max(frac ? frac.length : 0, precision);
    const scale = 10 ** digits;
    const total = Math.max(0, Math.round((stampToSeconds(min, sec, frac) + seconds) * scale));
    const m = Math.floor(total / (60 * scale));
    const rest = total - m * 60 * scale;
    const s = Math.floor(rest / scale);
    const f = rest - s * scale;
    const fraction = digits ? `${sep || "."}${String(f).padStart(digits, "0")}` : "";
    return `${open}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${fraction}${close}`;
  });
}

const SHIFTABLE = /([[<])(\d{1,3}):(\d{2})(?:([.:])(\d{1,3}))?([\]>])/g;

/** Tap-to-sync uses the original stamp, never the already corrected time. */
export function offsetAtPlayhead(stamp: number, playhead: number): number {
  return Math.round((stamp - playhead) * 1000) / 1000;
}

/** Explicit compatibility export; enhanced word stamps move with their lines. */
export function bakeLyricsOffset(text: string, offsetMs: number): { text: string; clamps: boolean } {
  const clamps = [...text.matchAll(SHIFTABLE)].some(match => stampToSeconds(match[2], match[3], match[5]) < offsetMs / 1000);
  return { text: setLyricsOffset(shiftLyrics(text, -offsetMs / 1000), 0), clamps };
}

export function isSynced(lines: LyricLine[]): boolean {
  return lines.length > 0 && lines.every((l) => l.time !== null);
}

/** Index of the line playing at `seconds`, or -1 before the first one. */
export function currentLineIndex(lines: LyricLine[], seconds: number): number {
  // Parsed synced lyrics are sorted. The overlay asks this ten times a second,
  // so find the last started line without rescanning from the beginning.
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const time = lines[middle].time;
    if (time !== null && time <= seconds) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function formatStamp(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** The only playback correction: LRC positive means sooner. Clamp only here. */
export function applyLyricOffset(stamp: number, offsetMs: number): number {
  return Math.max(0, stamp - offsetMs / 1000);
}

const OFFSET = /^\s*\[offset:([+-]?\d+)\]\s*$/i;
export function readLyricsOffset(text: string | null | undefined): number {
  let result = 0;
  for (const line of (text ?? "").split(/\r?\n/)) {
    const match = line.match(OFFSET);
    if (match) result = Number(match[1]);
  }
  return result;
}

/** Change only the tag; preserve stamps, word tags, and line endings. */
export function setLyricsOffset(text: string, offsetMs: number): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const tag = `[offset:${offsetMs > 0 ? "+" : ""}${offsetMs}]`;
  let found = false;
  const result: string[] = [];
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (OFFSET.test(line)) {
      if (offsetMs && !found) result.push(tag + (line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""));
      found = true;
    } else result.push(line);
  }
  if (offsetMs && !found) {
    let index = 0;
    while (index < result.length && /^\s*\[[a-z]+:.*\]\s*$/i.test(result[index])) index++;
    if (index && !result[index - 1].endsWith("\n")) result[index - 1] += newline;
    result.splice(index, 0, tag + newline);
  }
  return result.join("");
}
