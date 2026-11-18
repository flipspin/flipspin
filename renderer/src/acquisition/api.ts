import { apiUrl, relPathForTrack } from '@lib/api';
import { getLibraryRoot } from '@lib/libraryKeys';
import i18n from '../i18n';

export type CatalogTrack = {
  title: string;
  replaces?: string;
  isrc?: string | null;
  artistName?: string;
  albumTitle?: string;
  albumArtist?: string | null;
  durationSeconds?: number;
  trackPosition?: number;
  trackTotal?: number | null;
  discNumber?: number | null;
  discTotal?: number | null;
  compilation?: boolean | null;
  recordingMbid?: string | null;
  releaseMbid?: string | null;
  coverUrl?: string;
  ref?: { provider: string; id: string };
};
export type AcquisitionIdentity = { kind: 'song' | 'album' | 'playlist'; provider: string; provider_id: string; title: string };
export type AcquisitionItem = { idx: number; item: string; stage: string; state: string; reason: string | null; detail: { index?: number; percent?: number; error?: string; decision?: string; reason?: string; rel_path?: string } };
export type AcquisitionRequest = AcquisitionIdentity & { id: string; state: string; expected_tracks: number; imported_tracks: number; items?: AcquisitionItem[]; tracks?: { title: string; artist?: string; album?: string; provider_id?: string; track_number?: number }[] };
/** A refused add keeps the server's code so the page can offer the fix (`no-sources` → install a source). */
export class AcquisitionRefused extends Error {
  constructor(message: string, readonly code: string | null) { super(message); this.name = 'AcquisitionRefused'; }
}
export const isNoSources = (error: unknown): boolean => error instanceof AcquisitionRefused && error.code === 'no-sources';
export const isActive = (r?: AcquisitionRequest | null) => !!r && ['pending', 'approved', 'fetching', 'importing'].includes(r.state);
export async function acquisitionApi(path = '', body?: unknown): Promise<AcquisitionRequest> {
  const response = await fetch(apiUrl(`/api/acquisition/requests${path}`), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const code: string | null = typeof data.code === 'string' ? data.code : typeof data.detail?.reason === 'string' ? data.detail.reason : null;
    throw new AcquisitionRefused(code === 'no-sources' ? i18n.t("No audio source") : code === 'sin-espacio' ? i18n.t("Nest out of space") : i18n.t("Could not add."), code);
  }
  return response.json();
}
export function catalogIdentity(tracks: CatalogTrack[], identity?: AcquisitionIdentity): AcquisitionIdentity {
  return identity ?? { kind: tracks.length === 1 ? 'song' : 'album', provider: tracks[0]?.ref?.provider || 'catalog', provider_id: tracks.map(t => t.ref?.id || `${t.artistName || ''}:${t.title}`).join('|').slice(0, 500), title: tracks.length === 1 ? tracks[0]?.title : tracks[0]?.albumTitle || tracks[0]?.title };
}
export function submitAcquisition(tracks: CatalogTrack[], identity?: AcquisitionIdentity) {
  return acquisitionApi('', {
    ...catalogIdentity(tracks, identity),
    tracks: tracks.map(t => ({
      title: t.title, artist: t.artistName || '', album: t.albumTitle,
      provider_id: t.ref?.id, duration_s: t.durationSeconds, track_number: t.trackPosition,
      cover_url: t.coverUrl, isrc: t.isrc,
      // Ownership rows may still carry physical server paths. The new door
      // accepts the same library keys as the per-account library API.
      replaces: t.replaces ? relPathForTrack(t.replaces, getLibraryRoot()) ?? t.replaces : undefined,
      album_artist: t.albumArtist, disc_number: t.discNumber, track_total: t.trackTotal,
      disc_total: t.discTotal, compilation: t.compilation,
      recording_mbid: t.recordingMbid, release_mbid: t.releaseMbid,
    })),
  });
}
