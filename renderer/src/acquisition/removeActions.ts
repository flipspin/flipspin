import { refreshUpdatedPlaylists } from '../playlists/removeDeletedTracks';
import { markTrackAbsent } from '../library/trackPresence';
import { reportError } from '../lib/log';
import { useTranslation } from 'react-i18next';
import { getState as identityState, useIdentity } from '@state/identityStore';
import { relPathOf, useUserLibrary } from '@state/userLibraryStore';
import { bridge, hasBridge } from '../bridge';
import { getForcedOffline, useForcedOffline } from '../offline/mode';
import { getLibraryRoot, NEST, ROOT_ALBUM_KEY } from '@lib/libraryKeys';
import { connectionStore, useConnection } from '../connection/connection';
import { changeOfflineTracks } from '../offline/useOfflineStorage';
import { confirmAction } from '../ui/confirm';
import { announceLibraryChanged } from '../browse/resolve';
import { apiUrl } from '@lib/api';
import type { ApiData } from '../data/http';
import type { MenuItem } from '../albums/TrackContextMenu';
import { isDownloaded, refreshOffline, useOffline } from './offline';
import { removeLibrary } from './libraryActions';
import i18n from '../i18n';

export type RemovalTrack = { path?: string | null; relPath?: string | null; missingFromNest?: boolean };
type Identity = { status: string; me?: { id?: string; role?: string; source?: string } | null };
type RemovalState = {
  person: Identity;
  connected: boolean;
  downloaded: ReadonlySet<string>;
  library: ReadonlySet<string>;
};
const owner = (person: Identity) => person.status === 'ready' && person.me?.role === 'owner';
const realUser = (person: Identity) => person.status === 'ready' && person.me?.source === 'token';
const connected = () => {
  const status = connectionStore.getSnapshot();
  return !getForcedOffline() && (status.kind === 'no-bridge' || (status.kind === 'ready' && status.value?.connection.state === 'connected'));
};

/** Keep the additive server result so playlist refreshes follow committed writes. */
async function deleteTrackFile(path: string): Promise<ApiData<'/api/delete-track', 'post'>> {
  const response = await fetch(apiUrl('/api/delete-track'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
  return data;
}

/** Device copies only. Shrink every owning pin so overlapping collections cannot keep the copy. */
export async function removeDownloads(keys: string[]) {
  if (!hasBridge()) return;
  const pools = await bridge().invoke('offline:pools', { action: 'get' });
  await changeOfflineTracks(pools, keys, true);
  await refreshOffline();
}

function nestPath(track: RemovalTrack): string | null {
  if (track.path) return track.path;
  const root = getLibraryRoot();
  const key = relPathOf(track);
  if (!root || !key) return null;
  const [album, file] = key.split('/');
  if (!album || !file) return null;
  return `${root}/${album === ROOT_ALBUM_KEY ? '' : `${album.split(NEST).join('/')}/`}${file.split(NEST).join('/')}`;
}

/** One policy for rows, selections and headers. Counts describe each applicable subset. */
export function removeActions(tracks: RemovalTrack[], state: RemovalState, onChanged?: () => void): MenuItem[] {
  const t = i18n.t.bind(i18n);
  const keys = [...new Set<string>(tracks.map(relPathOf).filter(Boolean))];
  const downloads = keys.filter(key => state.downloaded.has(key));
  const library = realUser(state.person) ? keys.filter(key => state.library.has(key)) : [];
  const paths = owner(state.person) && state.connected
    ? [...new Set(tracks.filter(track => !track.missingFromNest).map(nestPath).filter((path): path is string => !!path))] : [];
  const principal = state.person.me?.id;
  const samePerson = () => identityState().me?.id === principal;
  const run = (action: () => Promise<void>) => async () => {
    if (!samePerson()) return;
    try { await action(); }
    catch (error) { reportError('library', { userMessage: t("Could not complete"), error }); }
  };
  const items: MenuItem[] = [];
  if (downloads.length) items.push({
    label: downloads.length > 1 ? t("Remove download ({{n}})", { n: downloads.length }) : t("Remove download"),
    onClick: run(async () => { await removeDownloads(downloads); onChanged?.(); }),
  });
  if (library.length) items.push({
    label: library.length > 1 ? t("Remove from my library ({{n}})", { n: library.length }) : t("Remove from my library"),
    onClick: run(async () => {
      if (!realUser(identityState())) return;
      await removeLibrary(library, library.some(key => state.downloaded.has(key)));
      onChanged?.();
    }),
  });
  if (paths.length) items.push({ type: 'separator' }, {
    label: paths.length > 1 ? t("Delete file from nest… ({{n}})", { n: paths.length }) : t("Delete file from nest…"),
    danger: true,
    onClick: run(async () => {
      if (!owner(identityState()) || !connected()) return;
      const ok = await confirmAction({
        title: paths.length > 1 ? t("Delete {{n}} files from the nest?", { n: paths.length, count: paths.length }) : t("Delete the file from the nest?"),
        message: t("Deletes it for everyone. It can't be undone."),
        confirmLabel: t("Delete file"), destructive: true,
      });
      if (!ok || !samePerson() || !owner(identityState()) || !connected()) return;
      try {
        // The endpoint takes one file; the selection has one confirmation.
        const results = await Promise.allSettled(paths.map(deleteTrackFile));
        const deleted = tracks.filter(track => paths.some((path, index) => path === nestPath(track) && results[index].status === 'fulfilled'));
        deleted.forEach(markTrackAbsent);
        if (samePerson()) await refreshUpdatedPlaylists(results.flatMap(result => result.status === 'fulfilled' ? result.value.playlistsUpdated ?? [] : []));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally { announceLibraryChanged(); onChanged?.(); }
    }),
  });
  return items;
}

/** Append only a nonempty section, merging adjacent separators. File deletion stays last. */
export function withRemoveActions(items: MenuItem[], removals: MenuItem[]): MenuItem[] {
  if (!removals.length) return items;
  const merged: MenuItem[] = items.length ? [...items, { type: 'separator' }, ...removals] : removals;
  return merged.filter((item, i, all) =>
    item.type !== 'separator' || (i < all.length - 1 && (i === 0 || all[i - 1].type !== 'separator')));
}

export function useRemovalActionsFor(tracks: RemovalTrack[], onChanged?: () => void) {
  useTranslation(); // Rebuild translated labels when the UI language changes.
  const person = useIdentity();
  const library = useUserLibrary();
  const connection = useConnection();
  const forcedOffline = useForcedOffline();
  const keys = [...new Set<string>(tracks.map(relPathOf).filter(Boolean))];
  const files = useOffline(keys);
  const state = {
    person, connected: !forcedOffline && connection.state === 'connected',
    downloaded: new Set(keys.filter(key => isDownloaded(files[key]))),
    library: new Set(Object.keys(library.byRelPath)),
  };
  return (songs: RemovalTrack[]) => removeActions(songs, state, onChanged);
}

export function useRemoveActions(tracks: RemovalTrack[], onChanged?: () => void): MenuItem[] {
  return useRemovalActionsFor(tracks, onChanged)(tracks);
}
