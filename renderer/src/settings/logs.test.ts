import { expect, it, vi } from 'vitest'
import { parseLog, levelWord, errorsToday } from './logs'

it.each([
  ['2026-11-13 17:34:30 INFO app.main: started', '2026-11-13T17:34:30.000Z'],
  ['2026-11-13 11:34:30-06:00 INFO app.main: started', '2026-11-13T17:34:30.000Z'],
  ['2026-11-13 23:19:30+05:45 INFO app.main: started', '2026-11-13T17:34:30.000Z'],
  ['2026-11-13 17:34:30+00:00 INFO app.main: started', '2026-11-13T17:34:30.000Z'],
  ['[2026-11-13][11:34:30-06:00][desktop][INFO] started', '2026-11-13T17:34:30.000Z'],
  ['[2026-11-13][23:19:30+05:45][desktop][INFO] started', '2026-11-13T17:34:30.000Z'],
  ['{"timestamp":"2026-11-13T11:34:30.123456-06:00","level":"ERROR","message":"failed"}', '2026-11-13T17:34:30.123Z'],
  ['{"timestamp":"2026-11-13T23:19:30+05:45","level":"ERROR","message":"failed"}', '2026-11-13T17:34:30.000Z'],
  ['{"timestamp":"2026-11-13T17:34:30","level":"ERROR","message":"failed"}', '2026-11-13T17:34:30.000Z'],
  ['{"timestamp":"2026-11-13T17:34:30Z","level":"ERROR","message":"failed"}', '2026-11-13T17:34:30.000Z'],
])('parses legacy and offset timestamps: %s', (line, expected) => {
  const entry = parseLog([line])[0]
  expect(entry.at?.toISOString()).toBe(expected)
  expect(entry.level).not.toBe('')
  expect(entry.raw).toBe(line)
})

it('keeps viewer-local date methods and counts errors across offset date boundaries', () => {
  const line = '2026-11-13 23:34:30-06:00 ERROR app.main: failed'
  const instant = new Date('2026-11-14T05:34:30Z')
  expect(parseLog([line])[0].at?.toLocaleString()).toBe(instant.toLocaleString())
  // Force the viewer's calendar date independently of the machine running Vitest.
  const localDate = vi.spyOn(Date.prototype, 'toDateString').mockImplementation(function (this: Date) {
    return new Date(this.getTime() + 9 * 3600_000).toISOString().slice(0, 10)
  })
  try {
    expect(errorsToday([line], new Date('2026-11-14T00:00:00Z'))).toBe(1)
    expect(errorsToday([line], new Date('2026-11-13T00:00:00Z'))).toBe(0)
  } finally {
    localDate.mockRestore()
  }
})

it('preserves original JSON, native and console text for copying', () => {
  for (const line of [
    '  {"timestamp":"2026-11-12T14:30:00Z","level":"ERROR","message":"failed"}  ',
    '  [2026-11-12][14:30:00][desktop][INFO] started  ',
    '  2026-11-12 14:30:00 INFO app.main: started  ',
  ]) expect(parseLog([line])[0].raw).toBe(line)
})

it('reads each native line with UTC time, target, level and renderer scope', () => {
  const entries = parseLog([
    '[2026-11-12][14:30:00][krobi_desktop_lib::desktop::proxy][WARN] HTTP failure request_id=test-1',
    '[2026-11-12][14:30:01][krobi_desktop_lib::desktop::bridge][ERROR] [renderer] [downloads] failed',
  ])
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ message: '[renderer] [downloads] failed', level: 'ERROR' })
  expect(entries[0].at?.toISOString()).toBe('2026-11-12T14:30:01.000Z')
  expect(levelWord(entries[1].level).tone).toBe('warn')
})
it('keeps separate helper messages while preserving traceback continuations', () => {
  const entries = parseLog(['helper connected', 'claim started', 'Traceback (most recent call last):', '  File example.py', 'ValueError: failed'])
  expect(entries).toHaveLength(2)
  expect(entries.find(entry => entry.message === 'claim started')?.raw).toContain('ValueError: failed')
})
