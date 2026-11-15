import { reportError } from '../lib/log';
import { useEffect, useMemo, useState, type ButtonHTMLAttributes } from 'react';
import { useRemoveActions } from './removeActions';
import RemovalMenu from './RemovalMenu';
import { ArrowDown, Check, Download, LibraryBig, Loader2, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isRealUser, useIdentity } from '@state/identityStore';
import { relPathOf, useUserLibrary } from '@state/userLibraryStore';
import { hasBridge } from '../bridge';
import { useConnection } from '../connection/connection';
import { useAcquisition } from '../browse/useAcquisition';
import { checkOwnership } from '../browse/browseApi';
import { isActive, type AcquisitionIdentity, type CatalogTrack } from './api';
import { isDownloaded, useOffline } from './offline';
import { writeLibrary } from './libraryActions';
import { trackProgress } from './trackProgress';
import { useProgressivePin } from './useProgressivePin';
import './acquisition.css';

type LocalTrack = { path?: string; relPath?: string; title: string };
type Props = { variant?: 'icons'; removalMenu?: boolean; kind: 'album' | 'playlist'; refId: string; title: string; tracks: LocalTrack[] | CatalogTrack[]; catalog?: boolean; provider?: string; verdicts?: { owned?: boolean; match?: LocalTrack }[]; acquisition?: ReturnType<typeof useAcquisition> };
function CollectionControl({ complete, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { complete: boolean }) {
  return complete ? <span role="img" aria-label={props['aria-label'] || props.title} className={props.className} title={props.title}>{props.children}</span> : <button {...props} />;
}
export default function CollectionActions(props: Props) {
  const { t } = useTranslation();
  const person = useIdentity();
  const connection = useConnection();
  const library = useUserLibrary();
  const identity: AcquisitionIdentity = { kind: props.kind, provider: props.provider || 'catalog', provider_id: props.refId, title: props.title };
  const ownAcquisition = useAcquisition(undefined, props.acquisition ? undefined : props.catalog ? identity : undefined);
  const acquisition = props.acquisition || ownAcquisition;
  const [resolved, setResolved] = useState<Props['verdicts']>([]);
  const [working, setWorking] = useState(false);
  const scope = `${person.me?.id}:${props.kind}:${props.provider}:${props.refId}`;
  const catalogTracks = props.tracks as CatalogTrack[];
  const { waitingDownload, start: startPin } = useProgressivePin({ scope, kind: props.kind, reference: props.refId, tracks: catalogTracks, request: acquisition.request, requests: acquisition.requests });
  const collectionRequest = acquisition.requests
    ? Object.values(acquisition.requests).reverse().find(request => request.kind === props.kind && request.provider === identity.provider && request.provider_id === props.refId) || null
    : acquisition.request;
  const collectionActive = isActive(collectionRequest);
  const progress = useMemo(() => trackProgress(collectionRequest, props.tracks as CatalogTrack[]), [collectionRequest, props.tracks]);
  const verdicts = props.verdicts || resolved;
  const keys = props.tracks.map((track, i) => props.catalog ? progress[i]?.key || (verdicts[i]?.owned ? relPathOf(verdicts[i].match) : null) : relPathOf(track));
  const validKeys: string[] = keys.filter(Boolean);
  const offline = useOffline(validKeys);
  const removalTracks = props.tracks.map((track, i) => ({
    ...(props.catalog ? verdicts[i]?.match : track), relPath: keys[i],
  }));
  const removals = useRemoveActions(removalTracks);
  const added = keys.filter((key, i) => (key && library.byRelPath[key]) || (props.catalog && (collectionActive || acquisition.retainedIds?.has(collectionRequest?.id)) && progress[i]?.published)).length;
  const addProgress = props.catalog && collectionRequest?.items?.length ? added
    : Math.min(props.tracks.length, acquisition.completed + Math.max(0, props.tracks.length - (acquisition.total || props.tracks.length)));
  const total = props.tracks.length;
  const complete = total > 0 && added === total;
  const downloaded = validKeys.filter(k => isDownloaded(offline[k])).length;
  const downloading = waitingDownload || validKeys.some(k => ['en fila', 'descargando'].includes(offline[k]?.state));
  const downloadComplete = total > 0 && downloaded === total;
  const personReason = !isRealUser(person) ? t("Sign in to your account to add and download.") : '';
  const disabledReason = personReason || (props.catalog && connection.state !== 'connected' ? t("Disconnected from the nest") : '');
  const downloadReason = personReason || (validKeys.length < total && connection.state !== 'connected' ? t("Disconnected from the nest") : '') || (!hasBridge() ? t("Downloading requires the desktop app.") : '');
  const busy = working || collectionActive;
  useEffect(() => {
    if (!props.catalog || props.verdicts || !props.tracks.length) return;
    let cancelled = false;
    void checkOwnership(catalogTracks).then(v => { if (!cancelled) setResolved(v); });
    return () => { cancelled = true; };
  }, [props.catalog, props.tracks, props.verdicts, catalogTracks, acquisition.completed, acquisition.ownershipRevision]);
  const fail = (error: Error) => reportError('acquisition', { userMessage: t("Could not complete"), error });
  const add = async () => {
    setWorking(true);
    try {
      const existing = validKeys.filter(k => !library.byRelPath[k]);
      if (existing.length) await writeLibrary(existing, 'POST');
      const missing = catalogTracks.filter((_t, i) => !keys[i]);
      if (props.catalog && missing.length) await acquisition.acquire(missing, identity);
    } catch (e) { fail(e as Error); }
    finally { setWorking(false); }
  };
  const startDownload = async () => {
    if (validKeys.length === total) void startPin(validKeys);
    else {
      const current = collectionRequest;
      const sameCollection = isActive(current) && current.kind === props.kind && current.provider === identity.provider && current.provider_id === props.refId;
      void startPin(validKeys, async () => sameCollection ? current : acquisition.acquire(catalogTracks, identity));
    }
  };
  const addWord = collectionActive ? t("Adding {{x}} / {{y}}", { x: addProgress, y: total }) : complete ? t("Added_masculine") : added ? t("Added {{x}} / {{y}}", { x: added, y: total }) : t("Add");
  const downloadWord = downloadComplete ? t("Downloaded") : downloading ? t("Downloading {{x}} / {{y}}", { x: downloaded, y: total }) : t("Download_verb");
  // The compact hero shares these counts and handlers with the labelled controls.
  if (props.variant === 'icons') {
    const adding = collectionActive;
    const addLabel = adding ? addWord
      : complete ? t("All {{n}} songs are in your library", { count: total, n: total })
      : added ? t("{{x}} of {{n}} in your library · add the {{y}} missing songs", { count: total - added, x: added, n: total, y: total - added })
      : t("Add all {{n}} songs to your library", { count: total, n: total });
    const downloadLabel = downloadComplete ? t("Downloaded")
      : downloading ? downloadWord
      : downloaded ? `${t("Download_verb")} · ${t("Downloaded {{x}} / {{y}}", { x: downloaded, y: total })}` : t("Download_verb");
    const addTip = [addLabel, disabledReason || acquisition.error?.message].filter(Boolean).join(' · ');
    const downloadTip = [downloadLabel, downloadReason].filter(Boolean).join(' · ');
    return <div className="acquire-actions acquire-actions--icons">
      <span title={addTip}>
        <CollectionControl complete={complete && !collectionActive} type="button" className={`acquire-action acquire-action--icon ${adding ? 'acquire-action--progress' : ''} ${complete && !adding ? 'is-complete' : ''}`} disabled={!!disabledReason || busy || !total} onClick={() => void add()} title={addTip} aria-label={addLabel}>
          <span className="acquire-action__glyph" aria-hidden="true">
            <LibraryBig size={18} strokeWidth={2.25} />
            {adding ? <Loader2 className="acquire-action__ring animate-spin" size={26} strokeWidth={2.25} />
              : complete ? <span className="acquire-action__badge"><Check size={9} strokeWidth={3} /></span>
              : added > 0 ? <span className="acquire-action__dot" /> : null}
          </span>
          {adding && <span className="acquire-action__count" aria-hidden="true">{addProgress}/{total}</span>}
        </CollectionControl>
      </span>
      <span title={downloadTip}>
        <CollectionControl complete={downloadComplete && !downloading} type="button" className={`acquire-action acquire-action--icon ${downloading ? 'acquire-action--progress' : ''} ${downloadComplete ? 'is-complete' : ''}`} disabled={!!downloadReason || working || downloading || !total} onClick={() => void startDownload()} title={downloadTip} aria-label={downloadLabel}>
          <span className="acquire-action__glyph" aria-hidden="true">
            <Download size={18} strokeWidth={2.25} />
            {downloading ? <Loader2 className="acquire-action__ring animate-spin" size={26} strokeWidth={2.25} />
              : downloadComplete ? <span className="acquire-action__badge"><Check size={9} strokeWidth={3} /></span> : null}
          </span>
          {downloading && <span className="acquire-action__count" aria-hidden="true">{downloaded}/{total}</span>}
        </CollectionControl>
      </span>
      {props.removalMenu !== false && <RemovalMenu items={removals} className="acquire-action acquire-action--icon" />}
    </div>;
  }
  return <div className="acquire-actions">
    <span title={disabledReason || acquisition.error?.message}>
      <CollectionControl complete={complete && !collectionActive} type="button" className={`acquire-action ${complete ? 'is-complete' : ''}`} disabled={!!disabledReason || busy || !total} onClick={() => void add()} title={complete ? t("Added_masculine") : disabledReason || undefined}>
        {collectionActive ? <Loader2 className="animate-spin" size={16} strokeWidth={2.5} /> : complete ? <Check size={16} strokeWidth={2.5} /> : <Plus size={16} strokeWidth={2.5} />}<span>{addWord}</span>
      </CollectionControl>
    </span>
    <span title={downloadComplete ? t("Downloaded") : downloadReason || undefined}>
      <CollectionControl complete={downloadComplete && !downloading} type="button" className={`acquire-action ${downloadComplete ? 'is-complete' : ''}`} disabled={!!downloadReason || working || downloading || !total} onClick={() => void startDownload()} title={downloadComplete ? t("Downloaded") : downloadReason || undefined}>
        {downloading ? <Loader2 className="animate-spin acquire-download" size={16} strokeWidth={2.5} /> : <ArrowDown size={16} strokeWidth={2.5} className="acquire-download" />}<span>{downloadWord}</span>
      </CollectionControl>
    </span>
    {props.removalMenu !== false && <RemovalMenu items={removals} />}
  </div>;
}
