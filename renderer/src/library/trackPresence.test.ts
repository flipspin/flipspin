import { afterEach, expect, it } from 'vitest';
import { getLibraryRoot, ROOT_ALBUM_KEY, setLibraryRoot } from './libraryKeys';
import { isTrackPresent, markTrackAbsent, setLibraryPresence, trackLibraryKey } from './trackPresence';

afterEach(() => { setLibraryPresence(); setLibraryRoot(null); });
it('unknown loading state is present; an empty offline snapshot is authoritative', () => {
  const track = { relPath: 'Album/song.mp3' };
  setLibraryPresence();
  expect(isTrackPresent(track)).toBe(true);
  setLibraryPresence([], 'saved-revision');
  expect(isTrackPresent(track)).toBe(false);
});
it('joins root, nested, disc, Windows and old absolute playlist paths with server relPath keys', () => {
  setLibraryRoot('/music');
  const cases = [
    ['/music/Artist/Album/CD 1/song.mp3', 'Artist∕Album/CD 1∕song.mp3'],
    ['/music/root.mp3', `${ROOT_ALBUM_KEY}/root.mp3`],
    ['/music/Artist/Album/song.mp3', 'Artist∕Album/song.mp3'],
  ];
  setLibraryPresence([{ tracks: cases.map(([, relPath]) => ({ relPath })) }]);
  for (const [path, relPath] of cases) {
    expect(trackLibraryKey({ path })).toBe(relPath);
    expect(isTrackPresent({ path })).toBe(true);
  }
  expect(isTrackPresent({ path: '/music/Artist/Album/removed.mp3' })).toBe(false);
  setLibraryRoot('C:\\Music');
  expect(trackLibraryKey({ path: 'C:\\Music\\Artist\\Album\\song.mp3' })).toBe('Artist∕Album/song.mp3');
  expect(getLibraryRoot()).toBe('C:/Music');
});
it('rebuilds legacy path keys when the root arrives, without losing session 404s', () => {
  setLibraryRoot(null);
  const path = '/music/Artist/Album/song.mp3';
  setLibraryPresence([{ tracks: [{ path }] }], 'one');
  markTrackAbsent({ relPath: 'Artist∕Album/missing.mp3' });
  setLibraryRoot('/music');
  expect(isTrackPresent({ relPath: 'Artist∕Album/song.mp3' })).toBe(true);
  expect(isTrackPresent({ relPath: 'Artist∕Album/missing.mp3' })).toBe(false);
});

it('a loaded snapshot identifies old absolute queue entries even before root discovery', () => {
  setLibraryRoot(null);
  setLibraryPresence([{ tracks: [{ path: '/music/Album/present.mp3', relPath: 'Album/present.mp3' }] }]);
  expect(isTrackPresent({ path: '/music/Album/present.mp3' })).toBe(true);
  expect(isTrackPresent({ path: '/music/Album/deleted.mp3' })).toBe(false);
  setLibraryPresence([]);
  expect(isTrackPresent({ path: '/music/Album/present.mp3' })).toBe(false);
});
it('retains a path-only 404 when root discovery later makes canonical keys available', () => {
  setLibraryRoot(null);
  const track = { path: '/music/Artist/Album/song.mp3' };
  setLibraryPresence([{ tracks: [track] }], 'one');
  markTrackAbsent({ relPath: track.path });
  setLibraryRoot('/music');
  expect(isTrackPresent(track)).toBe(false);
});
it('a new revision can restore a song even when a queued item carries an old missing flag', () => {
  const track = { relPath: 'Album/song.mp3', missingFromNest: true };
  setLibraryPresence([{ tracks: [track] }], 'one');
  expect(isTrackPresent(track)).toBe(false);
  setLibraryPresence([{ tracks: [{ relPath: track.relPath }] }], 'two');
  expect(isTrackPresent(track)).toBe(true);
});
