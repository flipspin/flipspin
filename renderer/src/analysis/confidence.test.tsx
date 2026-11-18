import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '../i18n'
import { bandFor, calibration, confidenceLine, accuracyData } from './calibration'
import { AnalysisValue } from './AnalysisValue'
import { AccuracyPage } from './AccuracyPage'
import { InformationAnalysis } from './InformationAnalysis'
import type { AnalysisTrack } from './display'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'

let fake: FakeSettings | undefined
afterEach(async () => { fake?.restore(); fake = undefined; await i18n.changeLanguage('es') })

describe('versioned calibration lookup', () => {
  for (const [name, bands] of Object.entries({ key: calibration.key, bpm: calibration.bpm, bpmOctave: calibration.bpmOctave })) {
    it(`${name}: lower edges, upper edges, shared boundaries, rounded gaps, and sample extremes`, () => {
      expect(bandFor(bands, 0)).toEqual(bands[0])
      expect(bandFor(bands, 1)).toEqual(bands.at(-1))
      bands.forEach((band, index) => {
        expect(bandFor(bands, band.conf_min)).toEqual(band)
        const next = bands[index + 1]
        expect(bandFor(bands, band.conf_max)).toEqual(next?.conf_min === band.conf_max ? next : band)
        if (next && band.conf_max < next.conf_min) expect(bandFor(bands, (band.conf_max + next.conf_min) / 2)).toEqual(band)
      })
    })
  }
  it.each([null, undefined, '0.5', NaN, Infinity, -0.1, 1.1])('omits an unavailable/invalid confidence: %s', score => {
    expect(confidenceLine('key', score)).toBeNull()
    expect(confidenceLine('bpm', score)).toBeNull()
  })
  it('uses deciles, including separate strict and octave BPM accuracies', () => {
    expect(confidenceLine('key', 0.012)).toBe('c = 0.012 · 75 %')
    expect(confidenceLine('bpm', 0.31)).toBe(`p = 0.31 · ${Math.round(calibration.bpm[1].pct)} % within ±4 % · ${Math.round(calibration.bpmOctave[1].pct)} % incl. ½/×2`)
  })
})

it.each([
  { field: 'key', score: 0.012, estimated: false, header: "Flipspin's calculation" },
  { field: 'key', score: 0.002, estimated: true, header: "Flipspin's estimate" },
  { field: 'bpm', score: 0.83, estimated: false, header: "Flipspin's calculation" },
  { field: 'bpm', score: 0.31, estimated: true, header: "Flipspin's estimate" },
] as const)('renders a two-line tooltip on focus for $field ($header)', async ({ field, score, estimated, header }) => {
  await i18n.changeLanguage('en')
  const track: AnalysisTrack = { key: '3A', bpm: 123, [`${field}Confidence`]: score, [`${field}Source`]: 'computed', [`${field}Estimated`]: estimated }
  const { container } = render(<AnalysisValue track={track} field={field} />)
  const trigger = container.querySelector<HTMLElement>('[tabindex="0"]')!
  const line = confidenceLine(field, score)!
  expect(trigger).toHaveAttribute('aria-label', `${header} · ${line}`)
  expect(trigger.querySelector('[title]')).toBeNull()
  fireEvent.focus(trigger)
  const tooltip = screen.getByRole('tooltip')
  expect(within(tooltip).getByText(header).tagName).toBe('B')
  expect(within(tooltip).getByText(line).tagName).toBe('CODE')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseEnter(trigger)
  expect(screen.getByRole('tooltip')).toHaveTextContent(line)
  fireEvent.mouseLeave(trigger)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it.each(['tag', 'fixed'] as const)('never shows calibration numbers for %s even with stale confidence', async source => {
  await i18n.changeLanguage('en')
  const { container } = render(<AnalysisValue track={{ key: '3A', keySource: source, keyConfidence: 0.012 }} field="key" />)
  const trigger = container.querySelector<HTMLElement>('[tabindex="0"]')!
  fireEvent.focus(trigger)
  expect(screen.getByRole('tooltip')).toHaveTextContent(source === 'tag' ? 'File tag' : 'Corrected by hand')
  expect(screen.getByRole('tooltip').textContent).not.toMatch(/\d|%|c =|p =/)
  expect(trigger.getAttribute('aria-label')).not.toMatch(/\d|%/)
})

it('renders the approved Accuracy tables and by-score bars from the shipped measurements', async () => {
  await i18n.changeLanguage('en')
  const { container } = render(<AccuracyPage />)
  const { giantsteps: g, library: l } = accuracyData
  const key = screen.getByRole('region', { name: 'Key' })
  expect(within(key).getByText(`${g.key.all.n} songs`, { exact: false })).toBeInTheDocument()
  expect(within(key).getByText(`${Math.round(g.key.confident.exact.pct)} %`)).toBeInTheDocument()
  expect(within(key).getByText(g.key.confident.exact.ci95.map(Math.round).join('–'))).toBeInTheDocument()
  const bpm = screen.getByRole('region', { name: 'BPM' })
  expect(within(bpm).getByText(`${Math.round(g.tempo.v2.all.accuracy1.pct)} %`)).toBeInTheDocument()
  const library = screen.getByRole('region', { name: 'Your library' })
  const keyRow = within(library).getByText('Key exact').closest('tr')!
  expect(keyRow).toHaveTextContent(`${l.key.gold.all.exact.n} songs · by hand`)
  expect(keyRow).toHaveTextContent(`${Math.round(l.key.gold.confident.exact.rate * 100)} %`)
  expect(library).toHaveTextContent('BPM ±2')
  expect(within(library).getAllByText('Not enough labels')).toHaveLength(4)
  const labelTip = within(library).getAllByText('Not enough labels')[0].closest('[tabindex="0"]')!
  fireEvent.focus(labelTip)
  expect(screen.getByRole('tooltip')).toHaveTextContent('2 key and 3 BPM labels')
  expect(container.querySelectorAll('.accuracy-bar')).toHaveLength(20)
  expect(container.querySelectorAll('.accuracy-bar--estimated')).toHaveLength(5)
  expect(screen.getAllByRole('table')).toHaveLength(4)
  expect(screen.queryByRole('region', { name: 'Other apps' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Test sets' })).toHaveTextContent('2026-11-12')
  expect(container.textContent).not.toMatch(/KeyFinder|TempoCNN/i)
})

it('shows song confidence lines and opens Accuracy from their links, omitting lines for tags/corrections', async () => {
  await i18n.changeLanguage('en')
  const view = { key: { value: '3A', source: 'computed', estimated: false }, bpm: { value: 94, source: 'computed', estimated: true }, keyConfidence: 0.012, bpmConfidence: 0.31, computed: { key: '3A', bpm: 94 }, fixed: { key: null, bpm: null }, state: 'analyzed', rev: 0 }
  fake = installFakeSettings({ respond: request => decodeURIComponent(request.pathname) === '/api/analysis/Album/song.mp3' ? { status: 200, json: view } : request.pathname === '/api/me' ? { status: 200, json: { isOwner: false } } : undefined })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const navigate = vi.fn()
  window.addEventListener('krobi-show-settings', navigate)
  try {
    const { container } = render(<QueryClientProvider client={client}><dl><InformationAnalysis relPath="Album/song.mp3" track={{}} /></dl></QueryClientProvider>)
    const links = await screen.findAllByRole('link', { name: 'Accuracy' })
    expect(links).toHaveLength(2)
    expect(container.querySelectorAll('.analysis-confidence-line')[0]).toHaveTextContent(confidenceLine('key', 0.012)!)
    expect(container.querySelectorAll('.analysis-confidence-line')[1]).toHaveTextContent(confidenceLine('bpm', 0.31)!)
    fireEvent.click(links[0])
    expect(navigate.mock.calls[0][0].detail).toEqual({ section: 'accuracy' })
    act(() => client.setQueryData(['analysis', 'track', 'Album/song.mp3'], { ...view, key: { ...view.key, source: 'tag' }, bpm: { ...view.bpm, source: 'fixed', estimated: false } }))
    await waitFor(() => expect(container.querySelector('.analysis-confidence-line')).toBeNull())
    expect(screen.queryByRole('link', { name: 'Accuracy' })).toBeNull()
  } finally { window.removeEventListener('krobi-show-settings', navigate); client.clear() }
})
