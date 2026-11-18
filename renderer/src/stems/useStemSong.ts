import { poll } from '../data/poll'
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '../api/generated/schema';
import { apiDelete, apiGet, apiPost, queryKeys } from '../data';
import { getApiClient } from '../data/backend';
import { ApiError } from '../data/errors';
import { stemPlayer } from './StemPlayer';
import { trackKey, type StemTrack } from './stemApi';
import { useSplitDeletes } from '../settings/splitDeletes';

type Pending = components['schemas']['StemsPendingResponse'];
export type SongSplit = { ready: boolean; pending?: Pending; createdAt?: string };
export function useSplits(enabled = true) {
  const query = useQuery({ queryKey: queryKeys.stems.splits(), queryFn: ({ signal }) => apiGet('/api/stems', { signal }), enabled, staleTime: 5000 });
  return query;
}

/** The list uses the exact wire identity, including encoded album/file names. */
export function useStemSong(track: StemTrack | null, visible: boolean) {
  const client = useQueryClient();
  const [foreground, setForeground] = useState(() => !document.hidden);
  useEffect(() => {
    const change = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  const enabled = visible && foreground && !!track;
  const list = useSplits(enabled);
  const { hidden } = useSplitDeletes();
  const split = list.data?.splits.find(s => track && trackKey(s) === trackKey(track));
  const query = useQuery({
    queryKey: queryKeys.stems.song(track),
    enabled,
    queryFn: async ({ signal }): Promise<SongSplit> => {
      const api = await getApiClient();
      const result = await api.GET('/api/stems/{album}/{file}', { params: { path: { album: track!.album, file: track!.file } }, signal });
      if (result.response.status === 404) return { ready: false };
      if (!result.response.ok) throw new ApiError({ kind: 'http', status: result.response.status, method: 'GET', path: '/api/stems/{album}/{file}', body: result.error, message: 'Stems' });
      if (result.response.status === 202) {
        // The generated 200 body is unknown; the 202 model is declared by OpenAPI.
        const pending = result.data as Pending;
        if (!pending || typeof pending.status !== 'string' || typeof pending.agent?.online !== 'boolean') throw new Error('Invalid stems status');
        return { ready: false, pending };
      }
      const data = result.data;
      if (!data || typeof data !== 'object' || !('stems' in data)) throw new Error('Invalid stems manifest');
      // A stale split still serves 200. Only the job endpoint carries its progress.
      let pending: Pending | undefined;
      if (split?.stale) {
        const jobs = await apiGet('/api/stems/jobs', { signal });
        const job = jobs.jobs.find(s => trackKey(s) === trackKey(track!));
        if (job && ['queued', 'running', 'leased'].includes(job.status)) pending = { ...job, agent: jobs.agent };
        else void client.invalidateQueries({ queryKey: queryKeys.stems.splits() });
      }
      return { ready: true, pending, createdAt: 'createdAt' in data && typeof data.createdAt === 'string' ? data.createdAt : split?.createdAt };
    },
    refetchInterval: q => poll('active', !!(enabled && q.state.data?.pending && q.state.data.pending.status !== 'failed'), 2000, false),
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    // Discover splits completed elsewhere and deletion from another surface.
    if (enabled && list.data) void client.invalidateQueries({ queryKey: queryKeys.stems.song(track) });
    // Wire identity is stable even when callers construct a fresh track object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, !!list.data, !!split, split?.createdAt, split?.stale, track?.album, track?.file, client]);
  const ready = query.data?.ready;
  const updatedAt = query.dataUpdatedAt;
  const previous = useRef<{ key: string; pending: boolean } | null>(null);
  useEffect(() => {
    if (!enabled || !track || !query.data) return;
    const key = trackKey(track);
    const wasPending = previous.current?.key === key && previous.current.pending;
    previous.current = { key, pending: !!query.data.pending && query.data.pending.status !== 'failed' };
    if (!ready) return;
    if (wasPending && !query.data.pending && stemPlayer.active) stemPlayer.refresh(track, true);
    else stemPlayer.refresh(track);
    void client.invalidateQueries({ queryKey: queryKeys.stems.splits() });
    // One re-check per newly received ready result, never per list render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, updatedAt, enabled, client]);
  const request = useMutation({
    mutationFn: () => apiPost('/api/stems/request', { body: { album: track!.album, file: track!.file, priority: 'now' } }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.stems.song(track) }); },
  });
  const cancel = useMutation({
    mutationFn: () => apiDelete('/api/stems/{album}/{file}', { params: { path: { album: track!.album, file: track!.file } } }),
    onSuccess: async () => {
      stemPlayer.refresh(track!, true);
      await client.invalidateQueries({ queryKey: queryKeys.stems.all });
    },
  });
  return { ...query, split, data: track && hidden.has(trackKey(track)) ? { ready: false } as SongSplit : query.data, request, cancel };
}
