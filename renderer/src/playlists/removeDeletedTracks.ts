import { fetchPlaylist } from './playlistApi';
import type { ApiData } from '../data/http';
import { getState } from '../state/identityStore';

/** Read committed server results even when the desktop still has an older snapshot. */
export async function refreshUpdatedPlaylists(updates: ApiData<'/api/me/library', 'delete'>['playlistsUpdated'] = []) {
  const names = [...new Set(updates.map(update => update.name))];
  if (!names.length) return;
  const person = getState().me?.id;
  const results = await Promise.allSettled(names.map(name => fetchPlaylist(name, true)));
  if (getState().me?.id !== person) return;
  const playlists = results.flatMap(result => result.status === 'fulfilled' && result.value.ok ? [result.value.data] : []);
  window.dispatchEvent(new CustomEvent('playlists-changed', { detail: { names, playlists } }));
}
