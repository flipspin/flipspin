// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { AddonsStep } from './AddonsStep'

const helper = vi.hoisted(() => ({
  set: vi.fn(),
  status: { supported: true, eligible: true, hardware: { memoryBytes: 16 * 2 ** 30, jobs: ['align', 'stems'] } },
}))
vi.mock('../lyrics/macEngine', () => ({
  refreshMac: vi.fn(async () => null),
  setMacWorker: helper.set,
  useMacEngine: () => ({ available: true, lastError: null, status: helper.status }),
}))
let fake: FakeSettings | null = null
beforeEach(() => {
  helper.set.mockReset().mockResolvedValue(undefined)
  helper.status = { supported: true, eligible: true, hardware: { memoryBytes: 16 * 2 ** 30, jobs: ['align', 'stems'] } }
})
afterEach(() => { fake?.restore(); fake = null; delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ })
function start(desktop = true, owner = true) {
  if (desktop) globalThis.__TAURI_INTERNALS__ = {} as never
  fake = installFakeSettings({ respond: request => request.pathname === '/api/me' ? { status: 200, json: { id: 'u1', username: 'robin', isOwner: owner, source: 'token' } } : undefined })
  const done = vi.fn()
  render(<DataProvider><AddonsStep host={null} onBack={() => {}} onDone={done} /></DataProvider>)
  return done
}
async function pick() {
  const lyrics = screen.getByRole('checkbox', { name: 'Instalar Letras' })
  await waitFor(() => expect(lyrics).toBeEnabled())
  await userEvent.click(lyrics)
  expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled()
  await userEvent.click(screen.getByRole('checkbox', { name: 'Lo usaré solo con fines no comerciales' }))
}

describe('optional shared helper', () => {
  it('starts unchecked; Skip and Next with no selection never start a helper', async () => {
    const done = start()
    expect(screen.getAllByRole('checkbox').every(box => !(box as HTMLInputElement).checked)).toBe(true)
    expect(screen.getAllByText('Próximamente')).toHaveLength(2)
    expect([...document.querySelectorAll('.kob-specs dt')].map(el => el.textContent)).toEqual(['Alignment', 'Vocal isolation', 'M1 Pro', 'RTX 3060', 'Ryzen 5 5600', 'Accuracy', 'Separation', 'Beat tracking', 'M1 Pro', 'Ryzen 5 5600', 'RTX 3060', 'Output', 'Key', 'Tempo', 'M1 Pro', 'Ryzen 5 5600', 'Accuracy'])
    expect(screen.getByText('MMS_FA')).toHaveAttribute('title', expect.stringContaining('CC BY-NC 4.0'))
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(done).toHaveBeenCalledWith([])
    expect(helper.set).not.toHaveBeenCalled()
  })
  it('Skip ignores an optional selection without starting work', async () => {
    const done = start()
    await pick()
    await userEvent.click(screen.getByRole('button', { name: 'Omitir' }))
    expect(done).toHaveBeenCalledWith([])
    expect(helper.set).not.toHaveBeenCalled()
  })
  it.each([
    { desktop: false, owner: true, reason: 'Se activa desde la app de escritorio de ese equipo.' },
    { desktop: true, owner: false, reason: 'Solo una cuenta admin puede procesar para el nido' },
  ])('disables checkboxes with an honest tooltip: $reason', async ({ desktop, owner, reason }) => {
    const done = start(desktop, owner)
    const lyrics = screen.getByRole('checkbox', { name: 'Instalar Letras' })
    await waitFor(() => expect(lyrics.closest('label')).toHaveAttribute('title', reason))
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(done).toHaveBeenCalledWith([])
    expect(helper.set).not.toHaveBeenCalled()
  })
  it.each([
    { supported: false, eligible: true, memory: 16, jobs: ['align'], reason: 'No disponible en este sistema' },
    { supported: true, eligible: false, memory: 16, jobs: ['align'], reason: 'Este equipo ya es el nido' },
    { supported: true, eligible: true, memory: 4, jobs: ['align'], reason: 'Necesita 8 GB de memoria' },
    { supported: true, eligible: true, memory: 16, jobs: [], reason: 'Este equipo no puede hacer ninguno de estos trabajos' },
  ])('checks helper hardware before offering installation: $reason', async ({ supported, eligible, memory, jobs, reason }) => {
    helper.status = { supported, eligible, hardware: { memoryBytes: memory * 2 ** 30, jobs } }
    start()
    const lyrics = screen.getByRole('checkbox', { name: 'Instalar Letras' })
    expect(lyrics).toBeDisabled()
    await waitFor(() => expect(lyrics.closest('label')?.title).toContain(reason))
  })
  it('renders Analysis after Stems with the amber accent, exact facts and helper details', () => {
    start()
    const cards = [...document.querySelectorAll('.kob-addon')]
    expect(cards.map(card => card.querySelector('b')?.textContent)).toEqual(['Letras', 'Stems', 'Análisis', 'Ties', 'Recomendaciones'])
    const card = within(cards[2] as HTMLElement)
    expect(cards[2].querySelector('.kob-addon-dot--amber')).toBeInTheDocument()
    expect(card.getByText('Tono, BPM y ánimo de cada canción.')).toBeVisible()
    for (const [value, tip] of [
      ['KeyFinder', 'Tono de toda la canción · 73 % exacto en la prueba (60 canciones electrónicas de GiantSteps) · licencia GPL-3.0'],
      ['TempoCNN', 'BPM de toda la canción · 95 % exacto en la misma prueba · pesos AGPL-3.0, en ONNX'],
      ['≈ 1 s por canción', 'Medido: canción de 3:30, un hilo, MacBook Pro con M1 Pro (2021)'],
      ['≈ 2 s por canción', 'Aproximado, solo CPU, un hilo, canción de 3:30'],
      ['≈ 100 MB, sin el motor', 'Espacio que ocupa una vez instalado'],
      ['en tu computadora (helper)', 'Lo procesa esta Mac, o cualquier computadora con «Procesar para el nido» activado. El nido guarda tono y BPM de cada canción'],
    ]) expect(card.getByText(value)).toHaveAttribute('title', tip)
  })
  it('enables Analysis below 8 GB and starts the selected light add-on and worker', async () => {
    helper.status = { supported: true, eligible: true, hardware: { memoryBytes: 4 * 2 ** 30, jobs: ['analysis'] } }
    const done = start()
    const analysis = screen.getByRole('checkbox', { name: 'Instalar Análisis' })
    await waitFor(() => expect(analysis).toBeEnabled())
    for (const name of ['Letras', 'Stems']) {
      const checkbox = screen.getByRole('checkbox', { name: `Instalar ${name}` })
      expect(checkbox).toBeDisabled()
      expect(checkbox.closest('label')?.title).toContain('Necesita 8 GB de memoria')
    }
    await userEvent.click(analysis)
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await waitFor(() => expect(done).toHaveBeenCalledWith(['analysis']))
    expect(fake!.invokedWith('lyrics:engine-install')).toEqual([{ target: 'analysis' }])
    expect(helper.set).toHaveBeenCalledExactlyOnceWith(true)
  })
  it('picks Lyrics and Analysis together and retains the shared worker path', async () => {
    const done = start()
    await pick()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Instalar Análisis' }))
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await waitFor(() => expect(done).toHaveBeenCalledWith(['lyrics', 'analysis']))
    expect(fake!.invokedWith('lyrics:engine-install')).toEqual([{ target: 'analysis' }])
    expect(helper.set).toHaveBeenCalledExactlyOnceWith(true)
  })
  it.each([
    { supported: false, eligible: true, jobs: ['analysis'] },
    { supported: true, eligible: false, jobs: ['analysis'] },
    { supported: true, eligible: true, jobs: [] },
  ])('keeps shared eligibility restrictions on Analysis: %j', async ({ supported, eligible, jobs }) => {
    helper.status = { supported, eligible, hardware: { memoryBytes: 4 * 2 ** 30, jobs } }
    start()
    expect(screen.getByRole('checkbox', { name: 'Instalar Análisis' })).toBeDisabled()
  })
  it('shows a failed start on its card and Next can finish without it', async () => {
    helper.set.mockRejectedValue(new Error('nest-unreachable'))
    const done = start()
    await pick()
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo iniciar el motor.')
    expect(screen.getByRole('alert').closest('.kob-option')).toHaveTextContent('Letras')
    expect(done).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(done).toHaveBeenCalledWith([])
    expect(helper.set).toHaveBeenCalledExactlyOnceWith(true)
  })
  it('retries the same helper and returns the chosen add-on when it starts', async () => {
    helper.set.mockRejectedValueOnce(new Error('network-denied'))
    const done = start()
    await pick()
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Reintentar' }))
    expect(helper.set).toHaveBeenCalledTimes(2)
    expect(done).toHaveBeenCalledWith(['lyrics'])
  })
  it('Skip remains available while a helper start is pending and finishes only once', async () => {
    let resolve!: () => void
    helper.set.mockImplementation(() => new Promise<void>(done => { resolve = done }))
    const done = start()
    await pick()
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await userEvent.click(screen.getByRole('button', { name: 'Omitir' }))
    resolve()
    await waitFor(() => expect(done).toHaveBeenCalledExactlyOnceWith([]))
  })
})
