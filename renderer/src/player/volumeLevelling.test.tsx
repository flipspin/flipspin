import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import cases from '../../../contracts/replaygain.json'
import { albumKey, gainMultiplier, getVolumeLevelling, orderedAlbum, setVolumeLevelling, useVolumeLevelling, type VolumeLevelling } from './volumeLevelling'

describe('volume levelling', () => {
  beforeEach(() => localStorage.clear())
  for (const c of cases.playback) it(c.name, () => {
    expect(gainMultiplier(c.gain, c.mode as VolumeLevelling, c.albumOrder)).toBeCloseTo(c.factor, 8)
  })
  it('defaults to Auto, persists changes and updates every subscriber', () => {
    expect(getVolumeLevelling()).toBe('auto')
    const first = renderHook(useVolumeLevelling)
    const second = renderHook(useVolumeLevelling)
    act(() => setVolumeLevelling('off'))
    expect(first.result.current).toBe('off')
    expect(second.result.current).toBe('off')
    first.unmount()
    act(() => setVolumeLevelling('album'))
    expect(second.result.current).toBe('album')
    expect(renderHook(useVolumeLevelling).result.current).toBe('album')
  })
  it('does not apply malformed values or decoder output gain twice', () => {
    expect(gainMultiplier({ trackGain: NaN }, 'track', false)).toBe(1)
    expect(gainMultiplier({ trackGain: 0, baseGain: 6 }, 'track', false)).toBe(1)
  })
  it('uses folded album keys across discs and rejects mixed queues', () => {
    const one = { relPath: 'Artist∕Album/CD1∕01.flac' }
    const two = { relPath: 'Artist∕Album/CD2∕01.flac' }
    expect(albumKey(one)).toBe('Artist∕Album')
    expect(orderedAlbum([one, two])).toBe('Artist∕Album')
    expect(orderedAlbum([one, { relPath: 'Other/a.mp3' }])).toBeNull()
    expect(orderedAlbum([{ ...one, track_number: 2 }, { ...one, track_number: 1 }])).toBeNull()
    expect(orderedAlbum([{ ...one, discNumber: 2 }, { ...two, discNumber: 1 }])).toBeNull()
  })
})
