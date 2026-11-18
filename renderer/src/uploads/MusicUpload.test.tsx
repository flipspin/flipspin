import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import i18n from '../i18n'
import { DataProvider } from '../data'
import { MusicUpload } from '../onboarding/MusicUpload'
import { installMusicBoundary, uploadBatch, uploadFile } from './onboardingTestSupport'
import { isRetryableUpload } from './uploadStore'
import type { UploadFailure } from '../lib/ipc'

let boundary: ReturnType<typeof installMusicBoundary> | undefined
beforeEach(async () => { await i18n.changeLanguage('en') })
afterEach(async () => { cleanup(); boundary?.restore(); boundary = undefined; await i18n.changeLanguage('es') })
function show(batch = uploadBatch()) {
  boundary = installMusicBoundary({ batch })
  return render(<DataProvider><MusicUpload batch={batch} busy={false} analyseHere={false} onAnalyseHere={vi.fn()} /></DataProvider>)
}

it('shows the picked folder in review and falls back when the picker supplied files', async () => {
  const { rerender } = show()
  const review = await screen.findByRole('region', { name: 'Review' })
  expect(within(review).getByText('~/Music/Library')).toHaveAttribute('title', 'The folder you picked stays on this computer.')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Upload 26 songs' })).toBeEnabled())
  rerender(<DataProvider><MusicUpload batch={uploadBatch(1, { folder: null })} busy={false} analyseHere={false} onAnalyseHere={vi.fn()} /></DataProvider>)
  expect(within(review).getByText('Folder on this computer')).toBeInTheDocument()
})

it('names each file issue and counts only retryable reasons even when all states are failed', async () => {
  const reasons: UploadFailure[] = ['not-audio', 'changed', 'unreadable', 'damaged']
  show(uploadBatch(0, { phase: 'terminado', files: reasons.map((reason, index) => uploadFile(index, { reason, state: 'fallida' })) }))
  expect(await screen.findByText('4 songs need a look')).toBeInTheDocument()
  for (const [index, word] of ['Not audio', 'Changed while uploading', "Can't read", 'Damaged'].entries()) {
    const row = screen.getByText(`Song ${index}.flac`).closest('.music-issue')!
    expect(within(row as HTMLElement).getByText(word)).toBeInTheDocument()
  }
  expect(screen.getByRole('button', { name: 'Retry 2' })).toBeEnabled()
})

it.each<UploadFailure>(['not-audio', 'damaged', 'no-es-audio', 'archivo-danado'])('offers no retry for %s', reason => {
  show(uploadBatch(0, { phase: 'terminado', files: [uploadFile(0, { state: 'fallida', reason })] }))
  expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
})

it('uses the Spanish translations for the new reasons', async () => {
  await i18n.changeLanguage('es')
  show(uploadBatch(0, { phase: 'terminado', files: [uploadFile(0, { state: 'fallida', reason: 'changed' }), uploadFile(1, { state: 'fallida', reason: 'unreadable' })] }))
  expect(screen.getByText('Cambió durante la subida')).toBeInTheDocument()
  expect(screen.getByText('No se puede leer')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Reintentar 2' })).toBeEnabled()
})

it.each<UploadFailure>(['changed', 'unreadable', 'sin-espacio', 'fallo-subida'])('retains retry support for %s', reason => {
  expect(isRetryableUpload(uploadFile(0, { state: 'fallida', reason }))).toBe(true)
  expect(isRetryableUpload(uploadFile(0, { state: 'agregada', reason }))).toBe(false)
})
