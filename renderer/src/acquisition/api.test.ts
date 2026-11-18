import { afterEach, expect, it, vi } from 'vitest';
import { submitAcquisition } from './api';
import { setLibraryRoot } from '@lib/libraryKeys';

afterEach(() => { vi.unstubAllGlobals(); setLibraryRoot(null); });

it('sends known ISRC, replacement and album identity through the acquisition door', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'request' }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await submitAcquisition([{ title: 'Track', artistName: 'Artist', albumTitle: 'Album',
    ref: { provider: 'deezer', id: '123' }, isrc: 'USAAA2400001', replaces: 'Previous/old.mp3',
    albumArtist: 'Album Artist', trackPosition: 3, trackTotal: 12, discNumber: 2, discTotal: 2,
    compilation: false, recordingMbid: 'recording-id', releaseMbid: 'release-id' }]);
  const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain('/api/acquisition/requests');
  expect(options.method).toBe('POST');
  expect(JSON.parse(options.body as string)).toEqual({ kind: 'song', provider: 'deezer', provider_id: '123', title: 'Track',
    tracks: [{ title: 'Track', artist: 'Artist', album: 'Album', provider_id: '123', isrc: 'USAAA2400001',
      replaces: 'Previous/old.mp3', album_artist: 'Album Artist', track_number: 3, track_total: 12,
      disc_number: 2, disc_total: 2, compilation: false, recording_mbid: 'recording-id', release_mbid: 'release-id' }] });
});


it('reduces an ownership path against the server root and preserves nested library keys', async () => {
  setLibraryRoot('/srv/music');
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await submitAcquisition([{ title: 'Track', replaces: '/srv/music/Artist/Album/CD1/old.mp3' }]);
  const [, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(options.body as string).tracks[0].replaces).toBe('Artist∕Album/CD1∕old.mp3');
});
