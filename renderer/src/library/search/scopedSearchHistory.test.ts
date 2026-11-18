import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readScopedSearches, rememberScopedSearch, removeScopedSearch } from '../../browse/catalogSearchHistory';
import { librarySearchHistory } from './librarySearch';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
it('preserves all sixteen entries from the two legacy stores and does not collapse the same query across scopes', () => {
  const terms = Array.from({ length: 8 }, (_, n) => `term ${n}`);
  localStorage.setItem('krobi.recentLibrarySearches', JSON.stringify(terms));
  localStorage.setItem('krobi.recentCatalogSearches', JSON.stringify(terms));
  expect(readScopedSearches()).toHaveLength(16);
  expect(readScopedSearches().slice(0, 2)).toEqual([{ query: 'term 0', scope: 'library' }, { query: 'term 0', scope: 'explore' }]);
  rememberScopedSearch('term 7', 'explore');
  expect(readScopedSearches()).toHaveLength(16);
  expect(readScopedSearches()[0]).toEqual({ query: 'term 7', scope: 'explore' });
});
it('deduplicates within a scope, bounds the shared list, and removes from both saved and legacy records without resurrection', () => {
  localStorage.setItem('krobi.recentLibrarySearches', JSON.stringify(['cancion']));
  rememberScopedSearch(' CANCIÓN ', 'library');
  rememberScopedSearch('cancion', 'explore');
  expect(readScopedSearches()).toEqual([{ query: 'cancion', scope: 'explore' }, { query: 'CANCIÓN', scope: 'library' }]);
  librarySearchHistory.removeRecentSearch('cancion');
  expect(readScopedSearches()).toEqual([{ query: 'cancion', scope: 'explore' }]);
  for (let i = 0; i < 20; i++) rememberScopedSearch(`query ${i}`, 'library');
  expect(readScopedSearches()).toHaveLength(16);
  expect(readScopedSearches()[0]).toEqual({ query: 'query 19', scope: 'library' });
  removeScopedSearch({ query: 'QUERY 19', scope: 'library' });
  expect(readScopedSearches()).toHaveLength(15);
  expect(librarySearchHistory.readRecentSearches()).not.toContain('query 19');
});
it('ignores corrupt records, tolerates unavailable storage, and does not remember empty text', () => {
  localStorage.setItem('krobi.recentSearches', JSON.stringify([{}, null, { query: ' ', scope: 'explore' }, { query: 'x', scope: 'other' }]));
  expect(readScopedSearches()).toEqual([]);
  rememberScopedSearch('  ', 'library');
  expect(readScopedSearches()).toEqual([]);
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(() => rememberScopedSearch('query', 'library')).not.toThrow();
  expect(removeScopedSearch({ query: 'query', scope: 'library' })).toEqual([]);
});
