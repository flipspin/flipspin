import { poll as pollInterval, startPoll } from '../data/poll'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useIdentity, isRealUser } from '@state/identityStore';
import { announceLibraryJob } from '@lib/libraryEvents';
import { apiUrl } from '@lib/api';
import { acquisitionApi, isActive, isNoSources, submitAcquisition, type AcquisitionIdentity, type AcquisitionRequest, type CatalogTrack } from '../acquisition/api';
import { useConnection } from '../connection/connection';
import { useReplacementAcquisition } from './useReplacementAcquisition';
import { QueryClientContext } from '@tanstack/react-query';
import { refreshRestoredLibrary } from '../data/hooks/use-library-missing';
import { useUserLibrary } from '@state/userLibraryStore';

type ItemRetry = { index: number; youtube_url?: string };

const identityOf = (request: AcquisitionIdentity) => `${request.kind}:${request.provider}:${request.provider_id}`;
function retainPublished(previous: AcquisitionRequest | undefined, next: AcquisitionRequest): AcquisitionRequest {
  const receipts = previous?.items?.filter(item => item.stage === 'link' && item.state === 'done'
    && !next.items?.some(current => current.detail?.index === item.detail?.index && (current.state === 'failed' || (current.stage === 'link' && current.state === 'done')))) || [];
  return receipts.length ? { ...next, items: [...(next.items || []), ...receipts] } : next;
}

/** Every accepted request keeps its watcher and receipts until the page changes. */
export function useAcquisition(onFinished?, identity?: AcquisitionIdentity) {
  const client = useContext(QueryClientContext);
  const person = useIdentity();
  const library = useUserLibrary();
  const replacement = useReplacementAcquisition(onFinished);
  const replacementAcquire = replacement.acquire;
  const [replacing, setReplacing] = useState(false);
  const connection = useConnection();
  const [requests, setRequests] = useState<Record<string, AcquisitionRequest>>({});
  const [queuedRetries, setQueuedRetries] = useState<Record<string, ItemRetry[]>>({});
  const retries = useRef<Record<string, ItemRetry[]>>({});
  const [retainedIds, setRetainedIds] = useState(() => new Set<string>());
  const [ownershipRevision, setOwnershipRevision] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [starting, setStarting] = useState(false);
  // The add refused for lack of an audio source, replayed once a source is installed.
  const blocked = useRef<{ tracks: CatalogTrack[]; options?: AcquisitionIdentity } | null>(null);
  const finished = useRef(onFinished); finished.current = onFinished;
  const asked = useRef<Record<string, CatalogTrack[]>>({});
  const notified = useRef(new Set<string>());
  const identityKey = identity ? identityOf(identity) : '';
  const live = useRef(true);
  const busy = useRef(new Set<string>());
  const revision = useRef(0);
  const polling = useRef(new Set<string>());
  const personId = isRealUser(person) ? person.me.id : null;
  const complete = useCallback((next: AcquisitionRequest) => {
    if (notified.current.has(next.id)) return;
    notified.current.add(next.id);
    setOwnershipRevision(value => value + 1);
    announceLibraryJob(`acquisition:${next.id}`, next.state, next.imported_tracks);
    if (client && next.provider === 'library-readd' && next.imported_tracks > 0) void refreshRestoredLibrary(client).catch(e => setError(e as Error));
    finished.current?.(next, asked.current[next.id] || []);
  }, [client]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const version = ++revision.current;
    setRequests({}); setError(null); setStarting(false);
    retries.current = {}; setQueuedRetries({});
    asked.current = {}; notified.current.clear(); setRetainedIds(new Set()); busy.current.clear(); polling.current.clear();
    if (!identityKey || !personId) return;
    let cancelled = false;
    void fetch(apiUrl('/api/acquisition/requests')).then(r => r.ok ? r.json() : null).then(async data => {
      const listed: AcquisitionRequest[] = data?.requests || [];
      const latest = listed.find(request => identityOf(request) === identityKey);
      const found = listed.filter(request => isActive(request) || request.id === latest?.id).reverse();
      const details = await Promise.all(found.map(r => acquisitionApi(`/${r.id}`)));
      if (cancelled || version !== revision.current) return;
      setRetainedIds(previous => new Set([...previous, ...details.filter(isActive).map(detail => detail.id)]));
      setRequests(previous => ({ ...Object.fromEntries(details.map(detail => [detail.id, detail])), ...previous }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [identityKey, personId]);
  useEffect(() => {
    // Once personal membership catches up, subsequent library removals must
    // take precedence over this page's historical publication receipts.
    setRetainedIds(previous => {
      const released = [...previous].filter(id => {
        const request = requests[id];
        const landed = request?.items?.filter(item => item.stage === 'link' && item.state === 'done') || [];
        return !isActive(request) && landed.length > 0 && landed.every(item => library.byRelPath[item.detail?.rel_path]);
      });
      return released.length ? new Set([...previous].filter(id => !released.includes(id))) : previous;
    });
  }, [requests, library.byRelPath]);

  const watchIds = Object.values(requests).filter(request => isActive(request) || queuedRetries[request.id]?.length).map(request => request.id).sort().join('|');
  useEffect(() => {
    if (!watchIds || connection.state !== 'connected') return;
    let cancelled = false;
    const version = revision.current;
    const current = () => live.current && version === revision.current;
    const poll = async () => {
      await Promise.all(watchIds.split('|').map(async id => {
        if (polling.current.has(id)) return;
        polling.current.add(id);
        try {
          let next = await acquisitionApi(`/${id}`);
          if (!current()) return;
          // The server finishes the current stage graph before retrying one
          // manifest index. Do not expose that intermediate terminal state to
          // the album's device-download continuation.
          const selection = retries.current[id]?.[0];
          const index = selection?.index;
          let retryError: Error | null = null;
          if (!isActive(next) && index != null) {
            try {
              if (next.state !== 'rechazado') {
                const accepted = await acquisitionApi(`/${id}/retry`, selection);
                next = { ...next, ...accepted, items: [...(next.items || []).filter(item => item.detail?.index !== index), { idx: index, item: next.tracks?.[index]?.title || '', stage: 'request', state: 'queued', reason: null, detail: { index } }] };
                notified.current.delete(id);
              }
            } catch (e) { retryError = e as Error; }
            finally {
              if (current()) {
                retries.current = { ...retries.current, [id]: next.state === 'rechazado' ? [] : retries.current[id].slice(1) };
                setQueuedRetries(retries.current);
              }
            }
          }
          if (!current()) return;
          setRequests(previous => ({ ...previous, [id]: retainPublished(previous[id], next) })); setError(retryError);
          if (!isActive(next) && !retries.current[id]?.length) complete(next);
        } catch (e) { if (current()) setError(e as Error); }
        finally { if (current()) polling.current.delete(id); }
      }));
    };
    const stop = startPoll(() => pollInterval('active', !cancelled && current(), 1200, false), poll);
    return () => { cancelled = true; stop(); };
  }, [watchIds, connection.state, complete]);

  const acquire = useCallback(async (tracks: CatalogTrack[], options?: AcquisitionIdentity) => {
    if (!tracks?.length || !isRealUser(person) || connection.state !== 'connected') return;
    if (tracks.some(t => t.replaces)) { setReplacing(true); await replacementAcquire(tracks, undefined); return; }
    const submission = JSON.stringify([tracks, options]);
    if (busy.current.has(submission)) return;
    setReplacing(false);
    const version = revision.current;
    busy.current.add(submission); setStarting(true); setError(null);
    try {
      const accepted = await submitAcquisition(tracks, options);
      const next: AcquisitionRequest = { ...accepted, tracks: accepted.tracks || tracks.map(track => ({ title: track.title, artist: track.artistName, album: track.albumTitle, provider_id: track.ref?.id, track_number: track.trackPosition })) };
      if (live.current && version === revision.current) {
        asked.current[next.id] = tracks; setRetainedIds(previous => new Set(previous).add(next.id)); notified.current.delete(next.id);
        setRequests(previous => ({ ...previous, [next.id]: next }));
        announceLibraryJob(`acquisition:${next.id}`, next.state, next.imported_tracks);
        if (!isActive(next)) complete(next);
        return next;
      }
    } catch (e) {
      if (isNoSources(e)) blocked.current = { tracks, options };
      if (live.current && version === revision.current) setError(e as Error);
    }
    finally {
      if (live.current && version === revision.current) { busy.current.delete(submission); setStarting(busy.current.size > 0); }
    }
  }, [person, connection.state, replacementAcquire, complete]);
  /** Replays the add that was refused for lack of a source; clears the message either way. */
  const resumeBlocked = useCallback(async () => {
    const held = blocked.current;
    blocked.current = null;
    setError(null);
    if (held) await acquire(held.tracks, held.options);
  }, [acquire]);
  const dismissError = useCallback(() => { blocked.current = null; setError(null); }, []);

  // Only queued rows get an optimistic placeholder; sibling receipts remain
  // authoritative even while another request is submitted or retried.
  const visibleRequests = useMemo<Record<string, AcquisitionRequest>>(() => Object.fromEntries(Object.entries(requests).map(([id, request]) => {
    const indices = (queuedRetries[id] || []).map(selection => selection.index);
    return [id, indices.length ? { ...request, state: isActive(request) ? request.state : 'approved', items: [
      ...(request.items || []).filter(item => !indices.includes(item.detail?.index)),
      ...indices.map(index => ({ idx: index, item: request.tracks?.[index]?.title || '', stage: 'request', state: 'queued', reason: null, detail: { index } })),
    ] } : request];
  })), [requests, queuedRetries]);
  const candidates = Object.values(visibleRequests);
  const request = (identityKey ? [...candidates].reverse().find(request => identityOf(request) === identityKey) : candidates.at(-1)) || null;
  const retryItem = async (id: string, index: number, youtubeUrl?: string) => {
    if (!requests[id] || !isRealUser(person) || connection.state !== 'connected' || retries.current[id]?.some(selection => selection.index === index)) return;
    setRetainedIds(previous => new Set(previous).add(id));
    retries.current = { ...retries.current, [id]: [...(retries.current[id] || []), { index, ...(youtubeUrl ? { youtube_url: youtubeUrl } : {}) }] };
    setQueuedRetries(retries.current); setError(null);
  };
  const retry = async () => {
    if (!request || isActive(request) || !isRealUser(person) || connection.state !== 'connected') return;
    const version = revision.current;
    try {
      const next = await acquisitionApi(`/${request.id}/retry`, {});
      if (live.current && version === revision.current) {
        setRetainedIds(previous => new Set(previous).add(next.id)); notified.current.delete(next.id);
        setRequests(previous => ({ ...previous, [next.id]: next })); setError(null);
      }
    } catch (e) { if (live.current && version === revision.current) setError(e as Error); }
  };
  const cancel = async () => {
    if (!request || !isRealUser(person) || connection.state !== 'connected') return;
    const version = revision.current;
    try {
      const next = await acquisitionApi(`/${request.id}/cancel`, {});
      if (live.current && version === revision.current) {
        retries.current = { ...retries.current, [next.id]: [] }; setQueuedRetries(retries.current);
        setRequests(previous => ({ ...previous, [next.id]: next })); complete(next);
      }
    } catch (e) { if (live.current && version === revision.current) setError(e as Error); }
  };
  return { request: replacing ? null : request, requests: visibleRequests, retainedIds, ownershipRevision, active: replacing ? replacement.active : starting || candidates.some(isActive), total: replacing ? replacement.total : request?.expected_tracks || 0, completed: replacing ? replacement.completed : request?.imported_tracks || 0, error: replacing ? replacement.error : error, acquire, retry, retryItem, cancel, resumeBlocked, dismissError };
}
