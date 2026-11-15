import { refreshUpdatedPlaylists } from '../playlists/removeDeletedTracks';
import type { ApiData } from '../data/http';
import { reportError } from '../lib/log';
import { apiUrl } from '@lib/api';
import { getState, optimisticLibrary, libraryWriteSettled } from '@state/userLibraryStore';
import { getState as identityState, isRealUser } from '@state/identityStore';
import { bridge, hasBridge } from '../bridge';
import { confirmAction } from '../ui/confirm';
import { notify } from '../ui/notifications';
import { announceLibraryChanged } from '../browse/resolve';
import i18n from '../i18n';

async function sendLibrary(relPaths: string[], method: 'POST' | 'DELETE') {
  const response = await fetch(apiUrl('/api/me/library'), { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ relPaths }) });
  if (!response.ok) throw new Error(i18n.t("Could not update the library."));
  const result: ApiData<'/api/me/library', 'post'> | ApiData<'/api/me/library', 'delete'> = await response.json();
  if ('playlistsUpdated' in result) await refreshUpdatedPlaylists(result.playlistsUpdated);
  if ('missing' in result && result.missing?.length) throw new Error(i18n.t("No longer on the nest"));
}
export async function writeLibrary(relPaths: string[], method: 'POST' | 'DELETE') {
  const person = identityState().me?.id;
  const settle = optimisticLibrary(relPaths, method);
  try { await sendLibrary(relPaths, method); settle(true); }
  catch (error) { settle(); throw error; }
  finally { if (identityState().me?.id === person) { libraryWriteSettled(); announceLibraryChanged('acción en la biblioteca'); } }
}
/** DELETE starts only after the six-second undo window; it survives navigation. */
export async function removeLibrary(keys: string[], downloaded: boolean, message = i18n.t("Removed from your library")) {
  if (!isRealUser(identityState())) return;
  const person = identityState().me.id;
  if (downloaded && !await confirmAction({ title: i18n.t("Remove from my library"), message: i18n.t("The download on this device will also be removed."), confirmLabel: i18n.t("Remove from my library"), destructive: true })) return;
  if (identityState().me?.id !== person) return;
  const settle = optimisticLibrary(keys, 'DELETE');
  let undone = false;
  notify({ message, durationMs: 6000,
    action: { label: i18n.t("Undo"), onSelect: () => { undone = true; settle(); } },
    onExpire: () => {
      if (undone || identityState().me?.id !== person) return;
      void sendLibrary(keys, 'DELETE').then(() => settle(true)).catch(error => {
        settle(); if (identityState().me?.id === person) reportError('library', { userMessage: i18n.t("Could not update the library."), error });
      }).finally(() => { if (identityState().me?.id === person) { libraryWriteSettled(); announceLibraryChanged('acción en la biblioteca'); } });
    },
  });
}
export async function pinTracks(kind: 'song' | 'album' | 'playlist', ref: string, keys: string[], mode?: 'ensure' | 'append') {
  if (!isRealUser(identityState()) || !hasBridge()) return;
  const person = identityState().me.id;
  // Append callers have durable library-link receipts, even if the index lags.
  const tracks = keys.map(key => ({ key, inLibrary: mode === 'append' || !!getState().byRelPath[key] }));
  const settle = optimisticLibrary(keys, 'POST');
  try {
    const result = await bridge().invoke('offline:pin', { kind, ref, tracks, ...(mode ? { mode } : {}) });
    if (result.ok === false) {
      const words = { 'library-required-online': i18n.t("Connect to the nest to add to your library."), 'library-add-failed': i18n.t("Could not add."), 'track-missing': i18n.t("No longer on the nest"), 'no-space': i18n.t("Not enough space on this device") };
      throw new Error(words[result.reason]);
    }
    settle(true);
    return result.pinId;
  } catch (error) { settle(); throw error; }
  finally { if (identityState().me?.id === person) { libraryWriteSettled(); announceLibraryChanged('acción en la biblioteca'); } }
}
