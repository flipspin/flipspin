import { msg } from '../i18n';
import { reportError } from '../lib/log';
import { ArrowDown, Check, CircleAlert, CircleDot, Clock, FileX, Layers2, Loader2, RotateCcw, Search, WifiOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { isRealUser, useIdentity } from '@state/identityStore';
import { useUserLibrary } from '@state/userLibraryStore';
import { useConnection } from '../connection/connection';
import { useRowLibraryMissing } from '../data/library-missing-context';
import { rowText as t } from './rowText';
import type { AcquisitionItem, CatalogTrack } from './api';
import { useAcquisition } from '../browse/useAcquisition';
import { isDownloaded, refreshOffline, useOfflineTrack } from './offline';
import { pinTracks, removeLibrary, writeLibrary } from './libraryActions';
import { formatDuration } from '../ui/components/cardArt';
import { hasBridge } from '../bridge';
import { removeDownloads } from './removeActions';
import { RetrySheet } from '../downloads/DownloadRetryModal';
import './acquisition.css';

// Lucide's fixed Plus glyph (ISC), shared as a plain SVG element. The other
// states mount their own icon only when visible.
const plusIcon = <svg xmlns="http://www.w3.org/2000/svg" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-plus" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg>;

export type RowStateProps = { library?: boolean; acquired?: boolean; unavailable?: boolean; offline?: boolean; trackKey?: string; track?: CatalogTrack; catalog?: boolean; inNest?: boolean; near?: boolean; nearDuration?: number; missing?: boolean; busy?: boolean; item?: AcquisitionItem; onAdd?: () => void; onRetry?: (youtubeUrl?: string) => void | Promise<void>; title?: string; children?: ReactNode };
const reasonLabels = { 'no-encontrada': msg("Not found"), 'fallo-descarga': msg("Download failed"), 'fallo-importar': msg("Could not import"), 'sin-espacio': msg("Nest out of space"), 'en-pausa': msg("Paused") };
export function useRowState({ unavailable: unavailableProp, offline, trackKey, catalog, acquired, inNest, near, nearDuration, missing, busy, item }: RowStateProps) {
  const library = useUserLibrary();
  const missingPaths = useRowLibraryMissing();
  const file = useOfflineTrack(trackKey);
  const unavailable = unavailableProp || (offline && !(file?.verifiedAt != null && ['descargado', 'desactualizado', 'ya no está en el nido'].includes(file.state)));
  const saved = acquired || (!!trackKey && !!library.byRelPath[trackKey]);
  // Current acquisition receipts outrank stale device errors through landing.
  const acquiring = busy || (item && ['queued', 'running', 'done'].includes(item.state));
  const gone = !acquiring && (missing || missingPaths.has(trackKey) || (file?.state === 'ya no está en el nido' && file.verifiedAt != null && (offline || !inNest)));
  const offlineFailed = !acquiring && file?.state === 'fallido';
  const failed = item?.state === 'failed' || offlineFailed;
  const noMatch = failed && item?.reason === 'no-encontrada';
  const offlineQueued = file?.state === 'en fila' && (!acquiring || acquired);
  const queued = offlineQueued || item?.reason === 'en-pausa' || (!acquired && item?.state === 'queued');
  const adding = !failed && !acquired && (busy || item?.state === 'running' || item?.state === 'done');
  const searching = adding && item?.stage === 'match' && item.state === 'running';
  // A completed fetch's 100% belongs to acquisition, not the device transfer.
  const percent = !acquired && !offlineQueued && file?.state !== 'descargando' && item?.state === 'running' ? item.detail?.percent : undefined;
  const downloading = file?.state === 'descargando';
  const status = unavailable ? 'unavailable' : gone ? 'gone' : noMatch ? 'noMatch' : failed ? 'failed' : downloading ? null : queued ? 'queued' : searching ? 'searching' : adding ? 'adding' : saved ? null : near ? 'near' : catalog && inNest ? 'nest' : null;
  const reason = item?.detail?.error || (status && reasonLabels[item?.reason] ? t(reasonLabels[item.reason]) : undefined) || file?.error;
  const label = status === 'unavailable' ? t("Unavailable offline") : status === 'gone' ? t("No longer in the nest · + adds it again") : status === 'noMatch' ? t("Not found") : status === 'failed' ? t(reasonLabels[item?.reason] || "Failed") : status === 'queued' ? t("Queued_line") : status === 'searching' ? t("Searching") : status === 'adding' ? (percent == null ? t("Adding") : t("Adding · {{x}} %", { x: Math.round(percent) })) : status === 'near' ? (nearDuration == null ? t("Another version") : t("Another version in the nest ({{duration}})", { duration: formatDuration(nearDuration) })) : status === 'nest' ? t("Already in the nest · added instantly") : '';
  return { unavailable, status, label, percent, saved, gone, failed, adding, downloading, offlineQueued, downloaded: isDownloaded(file), offlineFailed, reason };
}

function ProgressRing({ percent }: { percent?: number }) {
  if (percent == null) return <Loader2 size={13} strokeWidth={2.5} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  return <svg className="acquire-progress" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
    <circle cx={12} cy={12} r={9} opacity={0.2} />
    <circle cx={12} cy={12} r={9} pathLength={100} strokeDasharray={`${Math.max(0, Math.min(100, percent))} 100`} strokeLinecap="round" transform="rotate(-90 12 12)" />
  </svg>;
}
function StateIcon({ state }: { state: ReturnType<typeof useRowState> }) {
  if (!state.status) return null;
  const Icon = { unavailable: WifiOff, gone: FileX, noMatch: CircleAlert, failed: CircleAlert, queued: Clock, near: Layers2, nest: CircleDot }[state.status];
  return <span className={`acquire-state is-${state.status}`} role="img" title={state.label} aria-label={state.label}>
    {state.status === 'adding' || state.status === 'searching' ? <ProgressRing percent={state.percent} /> : <Icon size={13} strokeWidth={2.5} aria-hidden="true" />}
  </span>;
}
export function RowEnd(props: RowStateProps) {
  const state = useRowState(props);
  return renderRowEnd(props, state);
}
/** A row that already computed state can share it without mounting a second set of hooks. */
// eslint-disable-next-line react-refresh/only-export-components
export function renderRowEnd(props: RowStateProps, state: ReturnType<typeof useRowState>) {
  return <div className="acquire-row-end">
    {state.unavailable ? <StateIcon state={state} /> : state.gone ? <MissingRowEnd props={props} state={state} /> : RowEndControls({ props, state })}
  </div>;
}
function MissingRowEnd({ props, state }: { props: RowStateProps; state: ReturnType<typeof useRowState> }) {
  const recovery = useAcquisition(() => { void refreshOffline(); });
  const percent = recovery.request?.items?.find(item => item.state === 'running' && item.detail?.percent != null)?.detail.percent;
  return <RowEndControls props={props} state={{ ...state, adding: state.adding || recovery.active, percent: percent ?? state.percent, reason: recovery.error?.message || state.reason }} onRecover={() => recovery.acquire([props.track || { title: props.title }], props.trackKey ? { kind: 'song', provider: 'library-readd', provider_id: props.trackKey, title: props.title || props.track?.title } : undefined)} />;
}
type RowControlsProps = { props: RowStateProps; state: ReturnType<typeof useRowState>; onRecover?: () => Promise<unknown> };
function RowEndControls(args: RowControlsProps) {
  if (!args.state.gone && ['queued', 'searching', 'adding'].includes(args.state.status) && !args.state.offlineQueued) return <RowEndAction {...args} />;
  return (args.state.gone || args.props.item?.state !== 'failed') && (args.props.library || args.props.catalog) && (args.state.saved || (args.props.library && args.state.gone))
    ? <LibraryRowEnd {...args} /> : <RowEndAction {...args} />;
}

/** Saved library and catalog rows share one device-download slot. */
function LibraryRowEnd({ props, state, onRecover }: RowControlsProps) {
  const person = useIdentity();
  const connection = useConnection();
  const [working, setWorking] = useState(false);
  const restoring = state.gone && (working || state.adding);
  const downloading = !state.gone && (state.downloading || state.offlineQueued || (working && !state.downloaded));
  const reason = !state.downloaded && !isRealUser(person) ? t("Sign in to your account to add and download.")
    : !state.gone && !hasBridge() ? t("Downloading requires the desktop app.")
    : (state.gone || !state.downloaded) && connection.state !== 'connected' ? t("Disconnected from the nest") : '';
  const label = state.gone ? t("Add again") : state.downloaded ? t("Remove download") : t("Download to this computer");
  const downloadLabel = downloading ? (state.percent == null ? t("Downloading") : t("Downloading · {{x}} %", { x: Math.round(state.percent) })) : '';
  const recoveryLabel = state.percent == null ? t("Re-adding") : t("Re-adding · {{x}} %", { x: Math.round(state.percent) });
  const action = async () => {
    setWorking(true);
    try {
      if (state.gone) {
        if (props.onAdd) props.onAdd();
        else await onRecover?.();
      } else if (state.downloaded) {
        await removeDownloads([props.trackKey]);
      } else {
        await pinTracks('song', props.trackKey, [props.trackKey]);
        await refreshOffline();
      }
    } catch (error) { reportError('downloads', { userMessage: t("Could not download"), error }); }
    finally { setWorking(false); }
  };
  return <>
    {state.gone ? <span className="acquire-state is-gone" role="img" title={t("Not on the nest")} aria-label={t("Not on the nest")}><FileX size={13} strokeWidth={2.5} aria-hidden="true" /></span>
      : downloading ? <span className="acquire-download acquire-action-slot" role="img" title={downloadLabel} aria-label={downloadLabel}><ProgressRing percent={state.percent} /></span> : null}
    {restoring ? <span className="acquire-download" role="img" title={recoveryLabel} aria-label={recoveryLabel}><ProgressRing percent={state.percent} /></span> : !downloading && <span className="acquire-action-slot" title={reason || state.reason || undefined}><button type="button" className={`song-row__action acquire-square ${state.gone ? '' : state.downloaded ? 'is-saved' : 'is-download'}`} disabled={!!reason || working || state.adding} title={reason || label} aria-label={label} onClick={event => { event.stopPropagation(); void action(); }}>
      {state.gone ? plusIcon : state.downloaded ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : <ArrowDown size={13} strokeWidth={2.5} aria-hidden="true" />}
    </button></span>}
  </>;
}
function RowEndAction({ props, state, onRecover }: { props: RowStateProps; state: ReturnType<typeof useRowState>; onRecover?: () => Promise<unknown> }) {
  const [manual, setManual] = useState(false);
  const person = useIdentity();
  const connection = useConnection();
  const checked = state.saved && !state.gone;
  const reason = !isRealUser(person) ? t("Sign in to your account to add and download.") : (state.gone || !props.inNest) && connection.state !== 'connected' ? t("Disconnected from the nest") : '';
  const recoveryLabel = state.percent == null ? t("Re-adding") : t("Re-adding · {{x}} %", { x: Math.round(state.percent) });
  const action = async () => {
    try {
      if (state.gone) {
        if (props.onAdd) props.onAdd();
        else await onRecover?.();
      }
      else if (failed) {
        if (props.item?.state === 'failed' && props.onRetry) await props.onRetry();
        else if (state.offlineFailed && props.trackKey) { await pinTracks('song', props.trackKey, [props.trackKey]); await refreshOffline(); }
        else if (props.onRetry) await props.onRetry();
        else props.onAdd?.();
      }
      else if (state.saved) await removeLibrary([props.trackKey], state.downloaded);
      else if (props.inNest && props.trackKey) await writeLibrary([props.trackKey], 'POST');
      else props.onAdd?.();
    } catch (e) { reportError('library', { userMessage: t("Could not update the library."), error: e }); }
  };
  const title = props.track?.title || props.title || props.item?.item || '';
  const query = [title, props.track?.artistName].filter(Boolean).join(' ');
  const noMatch = state.status === 'noMatch';
  const failed = noMatch || state.status === 'failed';
  const disabled = !!reason || state.adding || (checked && !props.trackKey) || (!state.gone && !state.saved && !props.onAdd && !props.onRetry && !props.inNest);
  const downloadLabel = state.downloading ? (state.percent == null ? t("Downloading") : t("Downloading · {{x}} %", { x: Math.round(state.percent) })) : '';
  return <>
    {!failed && state.downloaded && <span className="acquire-download" role="img" title={t("Downloaded")} aria-label={t("Downloaded")}><ArrowDown size={13} strokeWidth={2.5} aria-hidden="true" /></span>}
    {!failed && state.downloading && <span className="acquire-download" role="img" title={downloadLabel} aria-label={downloadLabel}><ProgressRing percent={state.percent} /></span>}
    {!failed && state.status && <StateIcon state={state} />}
    {state.gone && state.adding ? <span className="acquire-download" role="img" title={recoveryLabel} aria-label={recoveryLabel}><ProgressRing percent={state.percent} /></span> : ['queued', 'searching', 'adding'].includes(state.status) ? null : props.children && !failed ? props.children : <span className="acquire-action-slot" title={reason || undefined}><button type="button" className={`song-row__action acquire-square ${failed ? 'is-retry' : checked ? 'is-saved' : ''}`} disabled={disabled} title={reason || (failed ? state.label : state.gone ? t("Add again") : checked ? t("Remove from my library") : t("Add"))} aria-label={noMatch ? state.label : state.gone ? t("Add again") : failed ? t("Retry “{{title}}”", { title: props.title }) : checked ? t("Remove from my library") : t("Add “{{title}}”", { title: props.title })} onClick={e => { e.stopPropagation(); if (noMatch) setManual(true); else void action(); }}>
      {noMatch ? <Search size={13} strokeWidth={2.5} aria-hidden="true" /> : failed ? <span role="img" title={state.label} aria-label={state.label} className="is-failed"><RotateCcw size={13} strokeWidth={2.5} aria-hidden="true" /></span> : checked ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : plusIcon}
    </button></span>}
    {manual && <RetrySheet open failure={{
      index: props.item?.detail?.index ?? props.item?.idx ?? 0,
      item: props.item?.item || props.title || props.track?.title || '',
      title: title || null,
      artist: props.track?.artistName || null, durationS: props.track?.durationSeconds ?? null,
      query,
      kind: 'rejected', reason: props.item?.reason || null,
      suggestions: [...new Set([query, `${query} audio`, title])],
    }} onClose={() => setManual(false)} onPick={async url => { await props.onRetry?.(url); }} />}
  </>;
}
