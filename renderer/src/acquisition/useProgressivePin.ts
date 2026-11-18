import i18n from '../i18n';
import { reportError } from '../lib/log';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { acquisitionApi, isActive, type AcquisitionRequest, type CatalogTrack } from './api';
import { pinTracks } from './libraryActions';
import { queueOfflinePin, refreshOffline } from './offline';
import { trackProgress } from './trackProgress';

type Intent = {
  scope: string;
  seen: Set<string>;
  active: boolean;
  pending: number;
  tail: Promise<void>;
};
type Options = {
  scope: string;
  kind: 'album' | 'playlist';
  reference: string;
  tracks: CatalogTrack[];
  request?: AcquisitionRequest | null;
  requests?: Record<string, AcquisitionRequest>;
};

/** One device pin follows the accepted request, including later item retries. */
export function useProgressivePin({ scope, kind, reference, tracks, request, requests }: Options) {
  const intent = useRef<Intent | null>(null);
  const [binding, setBinding] = useState<{ intent: Intent; accepted: AcquisitionRequest } | null>(null);
  const [waitingDownload, setWaitingDownload] = useState(false);
  useEffect(() => {
    setBinding(null); setWaitingDownload(false);
    return () => { intent.current = null; };
  }, [scope]);

  const start = async (keys: string[], acquire?: () => Promise<AcquisitionRequest | void>) => {
    if (intent.current?.active || intent.current?.pending) return;
    const next: Intent = { scope, seen: new Set(keys), active: true, pending: 0, tail: Promise.resolve() };
    intent.current = next; setBinding(null); setWaitingDownload(true);
    try {
      // Persist the collection intent before submitting or joining acquisition.
      // Ensure preserves any children already downloaded on a previous press.
      await pinTracks(kind, reference, keys, acquire ? 'ensure' : undefined);
      if (intent.current !== next) return;
      void refreshOffline();
      const accepted = await acquire?.();
      if (intent.current !== next) return;
      if (accepted) setBinding({ intent: next, accepted });
      else { intent.current = null; setWaitingDownload(false); }
    } catch (error) {
      if (intent.current === next) {
        intent.current = null; setWaitingDownload(false);
        reportError('downloads', { userMessage: i18n.t("Could not download"), error });
      }
    }
  };

  // Publish the device ring for a landing receipt before the row paints.
  useLayoutEffect(() => {
    if (!binding || intent.current !== binding.intent || binding.intent.scope !== scope) return;
    const next = binding.intent;
    const current = requests?.[binding.accepted.id]
      || (request?.id === binding.accepted.id ? request : binding.accepted);
    if (current.state === 'rechazado') {
      // Keep completed downloads; queued continuations cannot attach new keys.
      intent.current = null; setWaitingDownload(false);
      return;
    }
    next.active = isActive(current);
    setWaitingDownload(next.active || next.pending > 0);
    const appendReceipts = (detail: AcquisitionRequest) => {
      if (intent.current !== next) return;
      for (const entry of trackProgress(detail, tracks)) {
        if (!entry.published || !entry.key || next.seen.has(entry.key)) continue;
        const key = entry.key;
        const settleDownload = queueOfflinePin(key);
        next.seen.add(key); next.pending++;
        setWaitingDownload(true);
        // Serial IPC preserves landing order and lets cancellation discard any
        // continuations that have not reached the shell yet.
        next.tail = next.tail.then(async () => {
          try {
            if (intent.current !== next) return;
            await pinTracks(kind, reference, [key], 'append');
            if (intent.current === next) void refreshOffline();
          } catch (error) {
            if (intent.current === next) reportError('downloads', { userMessage: i18n.t("Could not download"), error });
          } finally {
            await settleDownload();
            next.pending--;
            if (intent.current === next) setWaitingDownload(next.active || next.pending > 0);
          }
        });
      }
    };
    if (current.items?.length) appendReceipts(current);
    // Immediate POST/idempotency completions can contain only a summary.
    else if (!next.active) {
      let cancelled = false;
      next.pending++; setWaitingDownload(true);
      void acquisitionApi(`/${current.id}`).then(detail => {
        if (!cancelled && detail.state !== 'rechazado') appendReceipts(detail);
      }).catch(error => {
        if (!cancelled && intent.current === next) reportError('downloads', { userMessage: i18n.t("Could not download"), error });
      }).finally(() => {
        next.pending--;
        if (intent.current === next) setWaitingDownload(next.active || next.pending > 0);
      });
      return () => { cancelled = true; };
    }
  }, [binding, scope, request, requests, tracks, kind, reference]);

  return { waitingDownload, start };
}
