import { foldSearchText } from "../search/match";

const STORAGE_KEY = 'krobi.recentCatalogSearches';
const LEGACY_LIBRARY_KEY = 'krobi.recentLibrarySearches';
const UNIFIED_KEY = 'krobi.recentSearches';
const identity = (text: string) => foldSearchText(text).trim().replace(/\s+/g, ' ');
export type SearchScope = 'library' | 'explore';
export type ScopedSearch = { query: string; scope: SearchScope };

function readLegacy(key: string, minLength: number): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim().length >= minLength).slice(0, 8) : [];
  } catch { return []; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
}

/** Preserve the old string-list API and keys for existing callers. Both now
 * record into the one scoped list used by the top bar. */
export function createSearchHistory(key: string, minLength = 2) {
  const scope = key === LEGACY_LIBRARY_KEY ? 'library' : 'explore';
  const readRecentSearches = () => readLegacy(key, minLength);
  function rememberSearch(text: string) {
    if (text.trim().length >= minLength) rememberScopedSearch(text, scope);
  }
  function removeRecentSearch(query: string) {
    removeScopedSearch({ query, scope });
    return readRecentSearches();
  }
  return { readRecentSearches, rememberSearch, removeRecentSearch };
}
export const { readRecentSearches, rememberSearch, removeRecentSearch } = createSearchHistory(STORAGE_KEY);

/** Legacy lists have no timestamps. Retain both lists, interleaved by their
 * original position; subsequent explicit searches establish a shared order. */
export function readScopedSearches(): ScopedSearch[] {
  let saved: ScopedSearch[] = [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(UNIFIED_KEY) || '[]');
    if (Array.isArray(raw)) saved = raw.filter((row): row is ScopedSearch => !!row && typeof row === 'object'
      && typeof row.query === 'string' && !!row.query.trim() && (row.scope === 'library' || row.scope === 'explore'));
  } catch { /* storage may be unavailable */ }
  const library = readLegacy(LEGACY_LIBRARY_KEY, 1);
  const explore = readLegacy(STORAGE_KEY, 2);
  const merged: ScopedSearch[] = [];
  const append = (query: string | undefined, scope: SearchScope) => {
    if (query && !merged.some(row => row.scope === scope && identity(row.query) === identity(query))) merged.push({ query, scope });
  };
  saved.forEach(row => append(row.query, row.scope));
  for (let i = 0; i < Math.max(library.length, explore.length); i++) {
    append(library[i], 'library'); append(explore[i], 'explore');
  }
  return merged;
}
function saveScopedSearches(rows: ScopedSearch[]) {
  save(UNIFIED_KEY, rows);
  // Keep legacy readers consistent, including removals and the bounded history;
  // otherwise an old store could resurrect a removed or expired entry.
  save(LEGACY_LIBRARY_KEY, rows.filter(row => row.scope === 'library').map(row => row.query).slice(0, 8));
  save(STORAGE_KEY, rows.filter(row => row.scope === 'explore').map(row => row.query).slice(0, 8));
  window.dispatchEvent(new Event('search-history-changed'));
}
export function rememberScopedSearch(query: string, scope: SearchScope) {
  const term = query.trim();
  if (!term) return;
  const rows = readScopedSearches().filter(row => row.scope !== scope || identity(row.query) !== identity(term));
  saveScopedSearches([{ query: term, scope }, ...rows].slice(0, 16));
}
export function removeScopedSearch(entry: ScopedSearch) {
  const rows = readScopedSearches().filter(row => row.scope !== entry.scope || identity(row.query) !== identity(entry.query));
  saveScopedSearches(rows);
  return rows;
}
