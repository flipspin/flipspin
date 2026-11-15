import { describe, expect, it, vi } from 'vitest'
import { moves, playerReducer, playingWithIntent, type PlayerState } from './playerState'
import { PlaybackController } from './PlaybackController'
import { fakeAudio } from './fakeAudio'
import { log } from '../lib/log'

const expected: Record<PlayerState, PlayerState[]> = {
  idle: ['loading'], loading: ['playing', 'paused', 'retrying', 'failed'],
  playing: ['paused', 'buffering', 'retrying', 'ended', 'loading'],
  buffering: ['playing', 'retrying', 'paused'], paused: ['playing', 'loading'],
  retrying: ['loading', 'failed'], failed: ['loading', 'paused'], ended: ['loading', 'idle'],
}
describe('C3 state table', () => {
  it('accepts every allowed move and ignores every other move', () => {
    for (const from of Object.keys(expected) as PlayerState[]) {
      for (const to of Object.keys(expected) as PlayerState[]) {
        expect(playerReducer(from, to), `${from} → ${to}`).toBe(expected[from].includes(to) ? to : from)
      }
    }
    expect(Object.keys(moves)).toEqual(Object.keys(expected))
  })
  it('derives the UI value from state and intent', () => {
    for (const state of Object.keys(expected) as PlayerState[]) {
      expect(playingWithIntent(state, false)).toBe(['playing', 'buffering', 'retrying'].includes(state))
      expect(playingWithIntent(state, true)).toBe(['playing', 'buffering', 'retrying', 'loading'].includes(state))
    }
  })
  it('uses engine events, waits for actual playing, and logs invalid moves', () => {
    const debug = vi.spyOn(log.playback, 'debug').mockImplementation(() => {})
    const audio = fakeAudio()
    const controller = new PlaybackController({ advance: vi.fn(), notice: vi.fn() })
    const detach = controller.attach(audio.element)
    controller.setIntent(true)
    controller.select({ key: 'a/song', src: 'krobi-media://localhost/a/song', title: 'Song', origin: 'https://nest.example' })
    expect(controller.getSnapshot().state).toBe('loading')
    audio.emit('loadedmetadata'); audio.emit('canplay')
    expect(controller.getSnapshot().state).toBe('loading')
    audio.emit('playing')
    expect(controller.getSnapshot().state).toBe('playing')
    audio.emit('stalled'); audio.emit('suspend'); audio.emit('seeking'); audio.emit('seeked')
    expect(controller.getSnapshot().state).toBe('playing')
    audio.emit('waiting')
    expect(controller.getSnapshot().state).toBe('buffering')
    audio.emit('playing'); audio.emit('pause')
    expect(controller.getSnapshot().state).toBe('paused')
    audio.emit('ended')
    expect(controller.getSnapshot().state).toBe('paused')
    expect(debug).toHaveBeenCalledWith('ignored player transition', { from: 'paused', to: 'ended' })
    detach(); debug.mockRestore()
  })
})
