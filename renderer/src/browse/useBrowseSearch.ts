import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { foldSearchText } from '../search/match';
import { search } from './browseApi';

export const SEARCH_DELAY = 250;
export const validSearch = (text: string) => text.trim().length >= 2;
export type SearchMode = 'typing' | 'full';
export function catalogSearchKey(term: string, mode: SearchMode) {
  return ['browse-search', foldSearchText(term).trim().replace(/\s+/g, ' '), mode] as const;
}

export function useBrowseSearch(term: string, mode: SearchMode = 'full') {
  const result = useQuery({
    queryKey: catalogSearchKey(term, mode),
    queryFn: ({ signal }) => search(term.trim(), { mode, signal }),
    enabled: validSearch(term),
    placeholderData: keepPreviousData,
    staleTime: 15 * 60_000,
    retry: false,
  });
  // Query placeholders disappear on an error. Keep the last successful panels
  // available as well, so a failed subsequent query cannot blank the page.
  const [lastData, setLastData] = useState<typeof result.data>();
  useEffect(() => {
    if (result.data && !result.isPlaceholderData) setLastData(result.data);
  }, [result.data, result.isPlaceholderData]);
  const [lateKey, setLateKey] = useState<string | null>(null);
  const key = JSON.stringify(catalogSearchKey(term, mode));
  useEffect(() => {
    if (!result.isFetching) { setLateKey(null); return; }
    setLateKey(null);
    const timer = window.setTimeout(() => setLateKey(key), 300);
    return () => window.clearTimeout(timer);
  }, [result.isFetching, key]);
  return { ...result, data: result.data ?? lastData, showProgress: result.isFetching && lateKey === key };
}
