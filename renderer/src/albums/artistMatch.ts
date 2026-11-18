/** Match both whole artist tags and their parts, ignoring case and accents.
 * Only strip featured credits for links: splitting "Simon & Garfunkel" would open the wrong artist. */

// After a space or an opening bracket only; "ft" is also the end of "Daft".
const FEATURING = /(?:\s+|\s*[([]\s*)(?:feat\.?|ft\.?|featuring)\s.*$/i;
const SEPARATORS = /\s*(?:,|;|\/|&|\+|\sx\s|\sy\s|\sand\s|\swith\s|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s)\s*/i;

export function artistKey(name: unknown): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** What an artist cell links to: the tag without its "feat. …" tail. */
export function primaryArtist(tag: unknown): string {
  const s = String(tag ?? "").trim();
  return s.replace(FEATURING, "").trim() || s;
}

/** Every name a tag stands for, folded: the whole tag, its primary, and each part. */
export function artistKeysOf(tag: unknown): Set<string> {
  const s = String(tag ?? "").trim();
  const keys = new Set<string>();
  if (!s) return keys;
  keys.add(artistKey(s));
  keys.add(artistKey(primaryArtist(s)));
  for (const part of s.replace(/[()[\]]/g, " ").split(SEPARATORS)) {
    const k = artistKey(part);
    if (k) keys.add(k);
  }
  return keys;
}

/** Does this tag name the artist whose folded key is `key`? */
export function tagNames(tag: unknown, key: string): boolean {
  return Boolean(key) && artistKeysOf(tag).has(key);
}

/**
 * The album page's "More from <artist>": every other album whose tag names this
 * album's primary artist, in library order. Never the album itself; nothing
 * when it has no artist. Pinned by `contracts/album-page.json`.
 */
export function masDe<T extends { path?: unknown; artist?: unknown }>(album: T, albums: readonly T[]): T[] {
  const key = artistKey(primaryArtist(album.artist));
  if (!key) return [];
  return albums.filter((a) => String(a.path) !== String(album.path) && tagNames(a.artist, key));
}
