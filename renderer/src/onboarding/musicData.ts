import { poll } from '../data/poll'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGet, queryKeys, type ApiData } from '../data'

export type LibrarySummary = ApiData<'/api/library/summary', 'get'>

/** Health supplies live counts while the folder is being scanned. */
export function useMusicLibrary(readingNest: boolean, uploading: boolean, preview: boolean) {
  const scan = useQuery({ queryKey: ['library', 'scan'], queryFn: ({ signal }) => apiGet('/api/library/scan', { signal }),
    enabled: readingNest, retry: false, refetchInterval: query => poll('active', !!(query.state.data?.scanning || query.state.data?.pending), 1500, false) })
  const scanning = readingNest && (scan.isPending || !!scan.data?.scanning || !!scan.data?.pending)
  const interval = () => poll('active', scanning || uploading, 1500, false)
  const summary = useQuery({ queryKey: queryKeys.library.summary(), queryFn: ({ signal }) => apiGet('/api/library/summary', { signal }), retry: false, refetchInterval: interval })
  const health = useQuery({ queryKey: ['library', 'health'], queryFn: ({ signal }) => apiGet('/api/library/health', { signal }), retry: false, refetchInterval: interval })
  const albums = useQuery({ enabled: preview, queryKey: ['library', 'onboarding-albums'], queryFn: async ({ signal }) => {
    const listing = await apiGet('/api/listar-albums-con-metadata', { params: { query: { covers: false } }, signal })
    return (listing as { album?: string }[]).map(album => album.album ?? '').filter(Boolean).slice(0, 12)
  }, retry: false, refetchInterval: interval })
  const refreshSummary = summary.refetch
  const refreshHealth = health.refetch
  const refreshAlbums = albums.refetch
  useEffect(() => {
    if (!scan.data || scan.data.scanning || scan.data.pending) return
    void refreshSummary(); void refreshHealth(); if (preview) void refreshAlbums()
  }, [scan.data, refreshSummary, refreshHealth, refreshAlbums, preview])
  const songs = health.data?.stats?.songs
  const albumCount = health.data?.stats?.albums
  const validSummary = summary.data && typeof summary.data.folder === 'string' && typeof summary.data.songs === 'number'
    && typeof summary.data.albums === 'number' && typeof summary.data.artists === 'number' ? summary.data : null
  const found = validSummary ? { ...validSummary,
    ...(songs?.state === 'ready' && typeof songs.value === 'number' ? { songs: songs.value } : {}),
    ...(albumCount?.state === 'ready' && typeof albumCount.value === 'number' ? { albums: albumCount.value } : {}),
  } : null
  return { summary: found, ready: summary.isFetched && health.isFetched, albums: albums.data ?? [], scanning, failed: summary.isError || (summary.isSuccess && !validSummary) || (readingNest && scan.isError),
    refresh: () => { void refreshSummary(); void refreshHealth(); if (preview) void refreshAlbums(); if (readingNest) void scan.refetch() } }
}
