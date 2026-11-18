import { describe, expect, it } from 'vitest'

import { bakeLyricsOffset, offsetAtPlayhead, currentLineIndex, formatStamp, isSynced, parseLyrics, setLyricsOffset, shiftLyrics } from './lrc'
import cases from '../../../contracts/lyrics-offset.json'
import { lyricsKeyOf, splitRelPath } from './lyricsStore'

const LRC = `[ti:Tête brûlée]
[ar:Stromae]
[00:12.40] Le café brûlé refroidit sur la table
[00:17.9]Et le chat s'endort
[00:40.00][01:50.00] Encore, encore
[00:25.123] <00:25.12>Mira, <00:26.00>mañana llueve
`

describe('parseLyrics', () => {
  it('reads stamps, honours offset, strips word tags and unfolds repeats in time order', () => {
    const lines = parseLyrics(LRC)
    expect(lines.map((l) => [l.time, l.text])).toEqual([
      [12.4, "Le café brûlé refroidit sur la table"],
      [17.9, "Et le chat s'endort"],
      [25.123, 'Mira, mañana llueve'],
      [40, 'Encore, encore'],
      [110, 'Encore, encore'],
    ])
    expect(isSynced(lines)).toBe(true)
  })

  it('treats plain text as untimed lines and keeps their order', () => {
    const lines = parseLyrics('Uno\n\nDos\r\nTres\n')
    expect(lines).toEqual([
      { time: null, text: 'Uno' },
      { time: null, text: 'Dos' },
      { time: null, text: 'Tres' },
    ])
    expect(isSynced(lines)).toBe(false)
  })

  it('drops untimed lines from a synced lyric rather than sorting them to the top', () => {
    const lines = parseLyrics('Intro sin tiempo\n[00:05.00] Primera\n')
    expect(lines).toEqual([{ time: 5, text: 'Primera' }])
  })

  it('handles nothing', () => {
    expect(parseLyrics('')).toEqual([])
    expect(parseLyrics(null)).toEqual([])
  })
})

describe('currentLineIndex', () => {
  const lines = parseLyrics('[00:10.00] a\n[00:20.00] b\n[00:30.00] c\n')
  it('is -1 before the first line, then the last line that has started', () => {
    expect(currentLineIndex(lines, 3)).toBe(-1)
    expect(currentLineIndex(lines, 10)).toBe(0)
    expect(currentLineIndex(lines, 29.9)).toBe(1)
    expect(currentLineIndex(lines, 99)).toBe(2)
  })
})

describe('formatStamp', () => {
  it('pads to mm:ss and blanks nothing', () => {
    expect(formatStamp(0)).toBe('00:00')
    expect(formatStamp(754.7)).toBe('12:34')
    expect(formatStamp(null)).toBe('')
  })
})

describe('the song key', () => {
  it('is the last two path segments, from `path`, never url_path', () => {
    expect(lyricsKeyOf({ path: '/music/Multitude/Tete_brulee.mp3' })).toBe('Multitude/Tete_brulee.mp3')
    expect(lyricsKeyOf({ path: 'C:\\Krobi\\Music\\Multitude\\Tete_brulee.mp3' })).toBe('Multitude/Tete_brulee.mp3')
    expect(lyricsKeyOf({ path: 'lonely.mp3' })).toBeNull()
    expect(lyricsKeyOf(null)).toBeNull()
  })

  it('splits back into what the routes take', () => {
    expect(splitRelPath('Multitude/Tete_brulee.mp3')).toEqual({ album: 'Multitude', file: 'Tete_brulee.mp3' })
  })
})

describe('shiftLyrics', () => {
  it('moves every stamp and word tag, keeps each one\'s digits, leaves header tags alone', () => {
    expect(shiftLyrics(LRC, 1.5)).toBe(`[ti:Tête brûlée]
[ar:Stromae]
[00:13.90] Le café brûlé refroidit sur la table
[00:19.4]Et le chat s'endort
[00:41.50][01:51.50] Encore, encore
[00:26.623] <00:26.62>Mira, <00:27.50>mañana llueve
`)
  })

  it('clamps at zero, carries over the minute and is a no-op for 0', () => {
    expect(shiftLyrics('[00:00.50]a\n[00:59.80]b\n[01:00]c', -0.7)).toBe('[00:00.00]a\n[00:59.10]b\n[00:59.3]c')
    expect(shiftLyrics('[00:59.80]b', 0.3)).toBe('[01:00.10]b')
    expect(shiftLyrics('[00:59.80]b', 0)).toBe('[00:59.80]b')
  })

  it('adds the precision needed to retain a fractional nudge in stamps and word tags', () => {
    expect(shiftLyrics('[00:03]<00:03>Words\n[00:05.1]Last', -0.25)).toBe('[00:02.75]<00:02.75>Words\n[00:04.85]Last')
    expect(shiftLyrics('[00:03]Words', -0.1)).toBe('[00:02.9]Words')
  })

  it('round-trips through the parser', () => {
    const before = parseLyrics(LRC).map((l) => l.time)
    const after = parseLyrics(shiftLyrics(LRC, -2)).map((l) => l.time)
    expect(after.map((t, i) => Number((before[i]! - t!).toFixed(3)))).toEqual([2, 2, 2, 2, 2])
  })
})

describe('shared offset contract', () => {
  it.each(cases.playback)('$name', ({text, playheadSeconds, currentLineIndex: expected}) => {
    expect(currentLineIndex(parseLyrics(text), playheadSeconds)).toBe(expected)
  })
  it.each(cases.setOffset)('$name', ({text, offsetMs, expected}) => {
    expect(setLyricsOffset(text, offsetMs)).toBe(expected)
  })
})

describe('explicit timing actions', () => {
  it('computes Now from the original stamp with the LRC sign', () => {
    expect(offsetAtPlayhead(30, 29.6)).toBe(0.4)
    expect(offsetAtPlayhead(30, 30.2)).toBe(-0.2)
  })
  it('bakes enhanced/repeated stamps, strips the tag, and preserves headers and CRLF', () => {
    expect(bakeLyricsOffset('[ti:Song]\r\n[offset:+400]\r\n[00:30.00][01:30.00]<00:30.00>Words\r\n', 400)).toEqual({
      text: '[ti:Song]\r\n[00:29.60][01:29.60]<00:29.60>Words\r\n', clamps: false,
    })
    expect(bakeLyricsOffset('[offset:+500]\n[00:00.20]<00:00.10>Early', 500)).toEqual({ text: '[00:00.00]<00:00.00>Early', clamps: true })
    expect(bakeLyricsOffset('[offset:-500]\n[00:00.20]Later', -500)).toEqual({ text: '[00:00.70]Later', clamps: false })
  })
})

it('keeps the original playback order when a correction clamps multiple lines to zero', () => {
  const text = '[00:30]Later stamp\n[00:10]Earlier stamp'
  expect(parseLyrics(text, 40000)).toEqual([
    { time: 0, text: 'Earlier stamp' }, { time: 0, text: 'Later stamp' },
  ])
  expect(parseLyrics(text, 0).map(line => line.text)).toEqual(parseLyrics(text, 40000).map(line => line.text))
})
