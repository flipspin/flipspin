/**
 * The renderer's copy of backend/app/utils/library_paths.py. Same cases, same
 * answers; a key built here that the server would build differently is a
 * song that 404s.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { albumDirName, parseTrackPath, relPathForTrack } from '../lib/api'
import contract from '../../../contracts/library-keys.json'
import { ROOT_ALBUM_KEY, NEST, keysForPath, setLibraryRoot } from './libraryKeys'

const ROOT = '/music'

afterEach(() => setLibraryRoot(null))

describe('keysForPath', () => {
  it('keeps a flat library exactly as it was', () => {
    expect(keysForPath(`${ROOT}/Discovery/01.mp3`, ROOT)).toEqual({ album: 'Discovery', file: '01.mp3' })
  })

  it('folds an Artist/Album library into one album key', () => {
    expect(keysForPath(`${ROOT}/Daft Punk/Discovery/01.mp3`, ROOT)).toEqual({
      album: `Daft Punk${NEST}Discovery`,
      file: '01.mp3',
    })
  })

  it('puts a disc folder in the file key', () => {
    expect(keysForPath(`${ROOT}/Pink Floyd/The Wall/CD2/01.flac`, ROOT)).toEqual({
      album: `Pink Floyd${NEST}The Wall`,
      file: `CD2${NEST}01.flac`,
    })
  })

  it('treats a disc-named folder at the root as an album', () => {
    expect(keysForPath(`${ROOT}/CD1/01.mp3`, ROOT)).toEqual({ album: 'CD1', file: '01.mp3' })
  })

  it('answers null outside the library or with no root known', () => {
    expect(keysForPath('/elsewhere/a/b.mp3', ROOT)).toBeNull()
    expect(keysForPath(`${ROOT}/a/b.mp3`, null)).toBeNull()
  })
})

describe('the helpers that build URLs and library rows', () => {
  it('prefer what the server sent', () => {
    expect(albumDirName({ mediaKey: `A${NEST}B`, path: '/x/A/B' })).toBe(`A${NEST}B`)
    expect(relPathForTrack({ relPath: `A${NEST}B/c.mp3`, path: '/nowhere' }, ROOT)).toBe(`A${NEST}B/c.mp3`)
  })

  it('derive nested keys once the root is known', () => {
    setLibraryRoot(ROOT)
    expect(parseTrackPath(`${ROOT}/Daft Punk/Discovery/01.mp3`)).toEqual({
      albumName: `Daft Punk${NEST}Discovery`,
      fileName: '01.mp3',
    })
    expect(albumDirName({ path: `${ROOT}/Daft Punk/Discovery` })).toBe(`Daft Punk${NEST}Discovery`)
  })

  it('fall back to the last two segments without a root', () => {
    expect(parseTrackPath('/somewhere/Discovery/01.mp3')).toEqual({ albumName: 'Discovery', fileName: '01.mp3' })
  })
})


describe('shared library key contract', () => {
  it.each(contract.cases)('keeps the two-segment identity for $path', ({ path, album, file }) => {
    expect(ROOT_ALBUM_KEY).toBe(contract.rootAlbumKey)
    expect(keysForPath(`${ROOT}/${path}`, ROOT)).toEqual({ album, file })
    setLibraryRoot(ROOT)
    expect(parseTrackPath(`${ROOT}/${path}`)).toEqual({ albumName: album, fileName: file })
    expect(relPathForTrack({ path: `${ROOT}/${path}` }, ROOT)).toBe(`${album}/${file}`)
  })

  it('derives the root album key for cover URLs', () => {
    setLibraryRoot(ROOT)
    expect(albumDirName({ path: ROOT })).toBe(ROOT_ALBUM_KEY)
  })
})
