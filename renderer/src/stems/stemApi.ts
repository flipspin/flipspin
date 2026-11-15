import { apiUrl, parseTrackPath, withMediaAccess } from '@lib/api';
import { getApiClient } from '../data/backend';
import type { ApiDataOr } from '../data/http';
import { STEMS, type Stem } from './mix';
import probeUrl from './fixtures/opus-probe.ogg?url';

export interface StemTrack { album: string; file: string; duration?: number }
// The 200 body is currently unknown in OpenAPI. This guarded fallback stops
// applying as soon as the server publishes a response model.
export type Manifest = ApiDataOr<'/api/stems/{album}/{file}', 'get', { track: { duration: number }; stems: Record<Stem, string> }>;
export const trackKey = (track: StemTrack) => JSON.stringify([track.album, track.file]);
export function stemTrack(track: { path: string; duration?: unknown } | null): StemTrack | null {
  if (!track) return null;
  const { albumName, fileName } = parseTrackPath(track.path);
  return albumName && fileName ? { album: albumName, file: fileName, duration: typeof track.duration === 'number' ? track.duration : undefined } : null;
}
export async function getManifest(track: StemTrack, signal: AbortSignal): Promise<Manifest | null> {
  const client = await getApiClient();
  const { response, data } = await client.GET('/api/stems/{album}/{file}', {
    params: { path: { album: track.album, file: track.file } }, signal,
  });
  if (response.status === 202 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Manifest: HTTP ${response.status}`);
  const manifest = data as Manifest;
  if (!Number.isFinite(manifest?.track?.duration) || manifest.track.duration <= 0 || !STEMS.every(stem => typeof manifest.stems?.[stem] === 'string' && manifest.stems[stem].startsWith('/api/stems/'))) throw new Error('Invalid stem manifest');
  return manifest;
}
export async function fetchStems(manifest: Manifest, signal: AbortSignal): Promise<ArrayBuffer[]> {
  // One controller for all four requests; a failed sibling cancels the entire song.
  return Promise.all(STEMS.map(stem => fetchWhole(withMediaAccess(apiUrl(manifest.stems[stem])), stem, signal)));
}

/** Read every Content-Range slice: a plain media-proxy GET may return only the first MiB. */
async function fetchWhole(url: string, stem: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${stem}: HTTP ${response.status}`);
  const first = await response.arrayBuffer();
  const range = response.status === 206 ? parseContentRange(response.headers?.get('content-range')) : null;
  if (!range || range.end + 1 >= range.total) return first;
  const parts: ArrayBuffer[] = [first];
  let next = range.end + 1;
  while (next < range.total) {
    const more = await fetch(url, { signal, headers: { Range: `bytes=${next}-` } });
    if (!more.ok) throw new Error(`${stem}: HTTP ${more.status}`);
    const body = await more.arrayBuffer();
    const got = parseContentRange(more.headers?.get('content-range'));
    if (more.status !== 206 || !got || got.start !== next || body.byteLength === 0) throw new Error(`${stem}: incomplete media range`);
    parts.push(body);
    next = got.end + 1;
  }
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(new Uint8Array(part), at);
    at += part.byteLength;
  }
  return whole.buffer;
}

function parseContentRange(value: string | null | undefined): { start: number; end: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number);
  return end >= start && total > end ? { start, end, total } : null;
}
export async function probeBytes(): Promise<ArrayBuffer> {
  const response = await fetch(probeUrl);
  if (!response.ok) throw new Error('Cannot load codec probe');
  return response.arrayBuffer();
}
