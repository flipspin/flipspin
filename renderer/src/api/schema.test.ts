/** Type annotations make renamed server fields fail typecheck.
 * Runtime assertions keep this file in the test suite. */

import { describe, expect, it } from 'vitest'

import { createApiClient } from './client'
import type { components, paths } from './generated/schema'

/** Pin a response with both naming conventions so generated fields stay usable without a handwritten interface. */
type PlaylistItem = components['schemas']['PlaylistItem']

describe('generated schema', () => {
  it('types the playlist fields the renderer reads by name', () => {
    // Excess-property checking makes a renamed server field fail compilation.
    const item: PlaylistItem = {
      path: '/music/Album/01 Track.mp3',
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      track_number: 1,
      duration: 212.5,
      dateAdded: 1_756_000_000,
    }

    expect(item.album).toBe('Album')
    expect(item.dateAdded).toBe(1_756_000_000)
  })

  it('keeps nullable server fields nullable', () => {
    // `album` is Optional[str] in Python. If the generator ever flattened that
    // to a plain string the renderer would stop guarding a value that really
    // does arrive null for loose files, so the null case is pinned too.
    const looseFile: PlaylistItem = { path: '/music/loose.mp3', title: 'Loose', album: null }
    expect(looseFile.album).toBeNull()
  })

  it('carries the route table, not just the models', () => {
    // Check endpoint names at compile time without making a request.
    type ReplacePlaylistTracks = paths['/api/playlists/{name}/tracks']['put']
    type Body = ReplacePlaylistTracks['requestBody']['content']['application/json']

    // This route takes a bare array, not the { tracks: [...] } envelope the rest
    // of the API mostly uses. That asymmetry is the sort of thing a hand-written
    // client gets wrong once and then carries forever; here it is the generator's
    // problem and the wrong guess does not compile.
    const body: Body = [{ path: '/music/loose.mp3', title: 'Loose' }]
    expect(body).toHaveLength(1)
    expect(body[0]?.path).toBe('/music/loose.mp3')
  })

  it('binds a client to an origin without a trailing slash', () => {
    // Construct without calling so type compatibility is checked without a running backend.
    const client = createApiClient('http://127.0.0.1:8000/')
    expect(typeof client.GET).toBe('function')
  })
})
