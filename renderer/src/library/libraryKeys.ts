/** Mirror backend library_paths.py: fold nested directories into one segment with U+2215.
 * Prefer server-provided identities; derive keys only when they are absent. */

/** Stands in for `/` inside one key segment. */
export const NEST = "∕";

/** 256 ASCII bytes: longer than a filesystem component; no folded key can match. */
export const ROOT_ALBUM_KEY = "~krobi-root~" + "~".repeat(244);

/** "CD1", "CD 2", "Disc 1", "Disk 01", "Disco 2"; a folder that belongs to the album above. */
const DISC_DIR = /^(?:cd|dis[ck]|disco|disque)\s*[-_.]?\s*\d{1,2}$/i;

export function isDiscDir(name: string): boolean {
  return DISC_DIR.test(name.trim());
}

export interface LibraryKeys {
  album: string;
  file: string;
}

/** Keys for a path relative to the music root, already split into segments. */
export function keysForSegments(segments: string[]): LibraryKeys | null {
  if (segments.length === 0) return null;
  if (segments.length === 1) return { album: ROOT_ALBUM_KEY, file: segments[0] };
  const folders = segments.slice(0, -1);
  const name = segments[segments.length - 1];
  // A disc folder joins the file key, unless it sits right at the root.
  if (folders.length >= 2 && isDiscDir(folders[folders.length - 1])) {
    return { album: folders.slice(0, -1).join(NEST), file: `${folders[folders.length - 1]}${NEST}${name}` };
  }
  return { album: folders.join(NEST), file: name };
}

const normalize = (value: string) => String(value).replace(/\\/g, "/").replace(/\/+$/, "");

/** Keys for an absolute path under `root`, or null outside it (or with no root known). */
export function keysForPath(absolute: string | null | undefined, root: string | null | undefined): LibraryKeys | null {
  if (!absolute || !root) return null;
  const file = normalize(absolute);
  const base = normalize(root);
  if (!file.startsWith(`${base}/`)) return null;
  return keysForSegments(file.slice(base.length + 1).split("/").filter(Boolean));
}

// The server's music root, once something has learnt it (LibraryContext, the
// per-user library store). A module value rather than a context so that the
// non-component callers; URL builders, stores; can read it.
let libraryRoot: string | null = null;
const rootListeners = new Set<() => void>();
export function subscribeLibraryRoot(listener: () => void): () => void {
  rootListeners.add(listener);
  return () => { rootListeners.delete(listener); };
}

export function setLibraryRoot(root: string | null | undefined): void {
  const next = root ? normalize(root) : null;
  if (next === libraryRoot) return;
  libraryRoot = next;
  rootListeners.forEach(listener => listener());
}

export function getLibraryRoot(): string | null {
  return libraryRoot;
}
