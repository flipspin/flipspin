import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data'
import { setLanguage } from '../i18n'
import { MusicStep } from './MusicStep'
import { LibraryEmptyState } from './LibraryEmptyState'
import { SetupEmptyStates } from './SetupEmptyStates'
import { UploadHost } from '../uploads/UploadHost'
import { openUpload } from '../uploads/actions'
import { installMusicBoundary, uploadBatch, uploadFile } from '../uploads/onboardingTestSupport'
import { Onboarding } from './Onboarding'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let boundary: ReturnType<typeof installMusicBoundary> | undefined
beforeEach(() => { setLanguage('en') })
afterEach(() => { cleanup(); boundary?.restore(); boundary = undefined; vi.unstubAllGlobals(); setLanguage('es') })
function start(options: Parameters<typeof installMusicBoundary>[0] = {}) {
  boundary = installMusicBoundary(options)
  const done = vi.fn()
  const view = render(<DataProvider><UploadHost /><MusicStep localNest={options.local ?? false} host={null} onDone={done} /></DataProvider>)
  return { done, ...view }
}
async function pick() { await user.click(await waitFor(() => screen.getByRole('button', { name: 'Choose a folder…' }))) }

describe('remote music onboarding', () => {
  it('opens an empty remote nest on two radio cards with upload selected', async () => {
    start()
    const group = await waitFor(() => screen.getByRole('radiogroup', { name: 'Where your music is' }))
    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    expect(within(group).getByRole('radio', { name: /On this computer/ })).toBeChecked()
    expect(within(group).getByRole('radio', { name: /Already on Nido/ })).not.toBeChecked()
    expect(screen.getByText('Empty')).toHaveAttribute('title', expect.stringContaining('Docker'))
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument()
  })
  it.each([{ freeBytes: 0, floorBytes: 0 }, { freeBytes: 26e6, floorBytes: 1 }])('disables Upload with a reason when space or the reserve is insufficient: %j', async space => {
    start(space)
    await pick()
    const upload = await waitFor(() => screen.getByRole('button', { name: 'Upload 26 songs' }))
    await waitFor(() => expect(upload).toHaveAttribute('title', 'Not enough space on Nido'))
    expect(upload).toBeDisabled()
    expect(screen.getByText(/Needs .*free/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Upload music' })).toBeNull()
  })
  it('fails closed while the nest cannot report space and offers a retry', async () => {
    start({ respond: request => request.pathname === '/api/uploads/space' ? { status: 503 } : undefined })
    await pick()
    expect(await waitFor(() => screen.getByRole('button', { name: 'Upload 26 songs' }))).toBeDisabled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload 26 songs' })).toHaveAttribute('title', 'Could not read space on Nido. Try again.'))
    expect(await waitFor(() => screen.getByRole('button', { name: 'Retry' }))).toBeInTheDocument()
  })
  it('reviews locally, changes the folder, uploads inline and keeps Next enabled', async () => {
    const { done } = start()
    await pick()
    const review = await waitFor(() => screen.getByRole('region', { name: 'Review' }))
    expect(within(review).getByRole('table')).toHaveTextContent('To upload26 songs · 26 MB')
    await user.click(within(review).getByRole('button', { name: 'Change' }))
    const upload = screen.getByRole('button', { name: 'Upload 26 songs' })
    await waitFor(() => expect(upload).toBeEnabled())
    expect(review.contains(upload)).toBe(false)
    await user.click(upload)
    expect(await waitFor(() => screen.getByText('Uploading from this computer'))).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByText('0 of 26')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByText('Analysing as songs arrive')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Upload music' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(done).toHaveBeenCalledOnce()
    expect(boundary!.registrations.get('upload:changed')).toBe(1)
  })
  it.each([
    ['no-network', 'no network'], ['asleep', 'this computer was asleep'], ['nest-unreachable', 'Nido is unreachable'],
    ['signed-out', 'signed out'], ['no-space', 'no space on Nido'], ['drive-missing', 'drive missing'],
  ] as const)('names the pause cause %s and leaves Next enabled', async (paused, words) => {
    start({ restored: uploadBatch(2, { phase: 'subiendo', paused }) })
    expect(await waitFor(() => screen.getByText(`Paused · ${words}`))).toHaveAttribute('title', expect.stringContaining('Continues automatically'))
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  })
  it.each([{ count: 25, helper: false, visible: false }, { count: 26, helper: false, visible: true }, { count: 26, helper: true, visible: false }])('gates local Analysis by eligible upload size and online helpers: %j', async ({ count, helper, visible }) => {
    start({ batch: uploadBatch(count), helper })
    await pick()
    await waitFor(() => expect(boundary!.fake.requests.some(request => request.pathname === '/api/compute/summary')).toBe(true))
    if (helper) await waitFor(() => screen.getByText('On Music helper'))
    const toggle = screen.queryByRole('switch', { name: 'Analyse on this computer' })
    expect(!!toggle).toBe(visible)
    if (visible) {
      await user.click(toggle!)
      expect(screen.getByText('On this computer, as songs arrive')).toBeInTheDocument()
      expect(boundary!.invocations.some(call => call.channel === 'lyrics:engine-install')).toBe(false)
    }
  })
  it('preselects Analysis in Engines without installing from Music', async () => {
    boundary = installMusicBoundary()
    render(<DataProvider><Onboarding entry="resume" onFinished={() => {}} /></DataProvider>)
    await pick()
    await user.click(await waitFor(() => screen.getByRole('switch', { name: 'Analyse on this computer' })))
    expect(boundary.invocations.some(call => call.channel === 'lyrics:engine-install')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Next' })))
    await waitFor(() => screen.getByRole('heading', { name: 'Engines' }))
    expect(screen.getByRole('checkbox', { name: 'Install Analysis' })).toBeChecked()
  })
  it('shows per-file issues and retries only when retryable files remain', async () => {
    const batch = uploadBatch(0, { phase: 'terminado', files: [uploadFile(0, { state: 'no-apta', reason: 'no-es-audio' }), uploadFile(1, { state: 'fallida', reason: 'fallo-subida' }), uploadFile(2, { state: 'no-apta', reason: 'archivo-danado' })] })
    start({ batch })
    await pick()
    expect(await waitFor(() => screen.getByText('3 songs need a look'))).toBeInTheDocument()
    expect(screen.getByText('Song 0.flac')).toBeInTheDocument()
    expect(screen.getByText('Not audio')).toBeInTheDocument()
    expect(screen.getByText('Damaged')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry 1' }))
    expect(boundary!.invocations).toContainEqual({ channel: 'upload:retry-failed', request: { id: batch.id } })
  })
  it('reads scanning counts from health and keeps reading until both scanning and pending clear', async () => {
    let scanning = true
    let songs = 0
    start({ respond: request => {
      if (request.pathname === '/api/library/scan') return { status: 200, json: { scanning, pending: scanning } }
      if (request.pathname === '/api/library/health') return { status: 200, json: { stats: { songs: { state: 'ready', value: songs }, albums: { state: 'ready', value: 2 } } } }
      return undefined
    } })
    await user.click(await waitFor(() => screen.getByRole('radio', { name: /Already on Nido/ })))
    expect(await waitFor(() => screen.getByText('Scanning…'))).toBeInTheDocument()
    songs = 7
    // The scan/health queries poll every 1,500 ms while work is pending.
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(await waitFor(() => screen.getByText('7', {}))).toBeInTheDocument()
    expect(screen.getByText('songs so far')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
    scanning = false
    songs = 12
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(await waitFor(() => screen.getByText('Ready', {}))).toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('12'))).toBeInTheDocument()
  })
  it.each([false, true])('offers an explicit analysis run for an existing library (local=%s)', async local => {
    start({ songs: 12, local })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Analyse now' })))
    expect(boundary!.fake.requests.find(request => request.pathname === '/api/analysis/runs')?.body).toEqual({ requestId: expect.any(String), mode: 'outdated', scope: 'library' })
    expect(await waitFor(() => screen.getByText('Started'))).toBeInTheDocument()
  })
  it('does not offer another analysis run when the new-library preview is empty', async () => {
    start({ songs: 12, respond: request => request.pathname === '/api/analysis/runs/preview' ? { status: 200, json: { size: 0 } } : undefined })
    await waitFor(() => screen.getByText('12'))
    await waitFor(() => expect(boundary!.fake.requests.some(request => request.pathname === '/api/analysis/runs/preview')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Analyse now' })).toBeNull())
  })
})

describe('no client path in server requests', () => {
  it('uses only picker kind, batch id and duplicate choice across all upload actions', async () => {
    const localPath = '/client-only/music-folder'
    const picker = vi.fn(async () => localPath)
    vi.stubGlobal('desktopAPI', { selectBaseDir: picker })
    start()
    await pick()
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Change' })))
    const upload = screen.getByRole('button', { name: 'Upload 26 songs' })
    await waitFor(() => expect(upload).toBeEnabled())
    await user.click(upload)
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Stop' })))
    act(() => boundary!.emit('upload:changed', uploadBatch(1, { phase: 'terminado', files: [uploadFile(0, { state: 'fallida', reason: 'fallo-subida' })] })))
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Retry 1' })))
    const writes = boundary!.invocations.filter(call => ['upload:start', 'upload:stop', 'upload:retry-failed'].includes(call.channel))
    expect(writes).toEqual([
      { channel: 'upload:start', request: { pick: 'folder' } }, { channel: 'upload:start', request: { pick: 'folder' } },
      { channel: 'upload:start', request: { id: 'upload-test', duplicates: 'use-nest' } },
      { channel: 'upload:stop', request: { id: 'upload-test' } }, { channel: 'upload:retry-failed', request: { id: 'upload-test' } },
    ])
    expect(picker).not.toHaveBeenCalled()
    expect(boundary!.fake.requests.every(request => request.body === null)).toBe(true)
    expect(boundary!.fake.requests.some(request => request.pathname === '/api/set-basedir')).toBe(false)
    expect(JSON.stringify([writes, boundary!.fake.requests])).not.toContain(localPath)
  })
})

it.each(['library', 'follow-up'] as const)('shows the same remote empty-library cards and Spotify row in %s', async surface => {
  boundary = installMusicBoundary()
  render(<DataProvider>{surface === 'library' ? <LibraryEmptyState /> : <SetupEmptyStates />}</DataProvider>)
  expect(await waitFor(() => screen.getByRole('radio', { name: /On this computer/ }))).toBeChecked()
  expect(screen.getByRole('radio', { name: /Already on Nido/ })).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument()
  await pick()
  expect(await waitFor(() => screen.getByRole('region', { name: 'Review' }))).toBeInTheDocument()
})
it('shares a single batch subscription with the sheet and cleans it up', async () => {
  const { unmount } = start()
  await pick()
  expect(boundary!.listenerCount('upload:changed')).toBe(1)
  expect(screen.queryByRole('dialog', { name: 'Upload music' })).toBeNull()
  act(() => openUpload())
  expect(await waitFor(() => screen.getByRole('dialog', { name: 'Upload music' }))).toBeInTheDocument()
  unmount()
  expect(boundary!.listenerCount('upload:changed')).toBe(0)
})
it('updates the same keep-awake preference in review and during upload', async () => {
  start()
  await pick()
  const toggle = await waitFor(() => screen.getByRole('switch', { name: 'Keep Flipspin and this computer awake until the upload is done' }))
  expect(toggle).toBeChecked()
  await user.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  const upload = screen.getByRole('button', { name: 'Upload 26 songs' })
  await waitFor(() => expect(upload).toBeEnabled())
  await user.click(upload)
  expect(await waitFor(() => screen.getByRole('switch', { name: 'Keep Flipspin and this computer awake until the upload is done' }))).not.toBeChecked()
  expect(boundary!.invocations).toContainEqual({ channel: 'upload:keep-awake', request: { enabled: false } })
})
it('shows unsupported keep-awake as a status without blocking the upload', async () => {
  start({ restored: uploadBatch(1, { phase: 'subiendo', awake: 'unsupported' }) })
  expect(await waitFor(() => screen.getByText('Sleep not blocked'))).toHaveAttribute('title', expect.stringContaining('Uploading continues'))
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
})
it('clears the visible batch on account changes', async () => {
  start()
  await pick()
  act(() => boundary!.emit('auth:changed', { userId: null, label: null, role: null, hasToken: false }))
  expect(await waitFor(() => screen.getByRole('radiogroup', { name: 'Where your music is' }))).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Review' })).toBeNull()
})

it('shows local hashing progress before review and keeps the sheet closed on batch events', async () => {
  start({ batch: uploadBatch(0, { phase: 'revisando', reviewed: 2, total: 26 }) })
  await pick()
  expect(await waitFor(() => screen.getByText('Reviewing…'))).toBeInTheDocument()
  expect(screen.getByText('2 of 26')).toBeInTheDocument()
  act(() => boundary!.emit('upload:changed', uploadBatch()))
  expect(await waitFor(() => screen.getByRole('button', { name: 'Upload 26 songs' }))).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Upload music' })).toBeNull()
})
it('does not let a delayed restored snapshot replace a newer batch event', async () => {
  let release: (value: { batches: ReturnType<typeof uploadBatch>[] }) => void = () => {}
  start({ status: () => new Promise(resolve => { release = resolve }) })
  await waitFor(() => screen.getByRole('button', { name: 'Choose a folder…' }))
  act(() => boundary!.emit('upload:changed', uploadBatch(1, { phase: 'subiendo', paused: 'no-network' })))
  await waitFor(() => screen.getByText('Paused · no network'))
  await act(async () => { release({ batches: [uploadBatch(1, { phase: 'subiendo', paused: 'asleep' })] }) })
  expect(screen.getByText('Paused · no network')).toBeInTheDocument()
  expect(screen.queryByText('Paused · this computer was asleep')).toBeNull()
})

it('uses singular copy for one upload candidate and one skipped song', async () => {
  start({ batch: uploadBatch(1) })
  await pick()
  expect(await waitFor(() => screen.getByRole('button', { name: 'Upload 1 song' }))).toBeInTheDocument()
  expect(screen.getByRole('table')).toHaveTextContent('1 song · 1 MB')
  act(() => boundary!.emit('upload:changed', uploadBatch(0, { phase: 'terminado', files: [uploadFile(0, { state: 'no-apta', reason: 'no-es-audio' })] })))
  expect(await waitFor(() => screen.getByText('1 song needs a look'))).toBeInTheDocument()
})
