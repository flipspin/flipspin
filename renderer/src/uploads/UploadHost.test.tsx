import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setFakeBridgeForTest } from '../bridge'
import type { KrobiBridge, UploadBatch, UploadItem } from '../lib/ipc'
import { UploadButton } from './UploadButton'
import { openUpload } from './actions'
import { UploadHost } from './UploadHost'

const stops: (() => void)[] = []
afterEach(() => { stops.splice(0).forEach(stop => stop()) })
function fixture() {
  const events = new Map<string, (value: unknown) => void>()
  let batches: UploadBatch[] = []
  let picks = 0
  const file = (id: string, state: UploadItem['state'], already = false): UploadItem => ({ id, sha256: id, name: `${id}.wav`, bytes: 1000, offset: already ? 1000 : 0, state, already, reason: null, duplicate: false })
  const invoke = vi.fn(async (channel: string, request: unknown) => {
    if (channel === 'server:get-status') return { connection: { state: 'connected', checks: [], since: 0, attempt: 0, lastError: null } }
    if (channel === 'upload:status') return { batches }
    if (channel === 'upload:start' && request && 'pick' in (request as object)) {
      const id = `batch-${++picks}`
      const selected = picks === 1 ? [file('one', 'por-subir')] : [file('one', 'ya-estaba', true), file('two', 'por-subir')]
      batches = [{ folder: null, id, phase: 'revisando', files: [], total: selected.length, reviewed: 0 }]
      return batches[0]
    }
    if (channel === 'upload:start') {
      batches[0] = { ...batches[0], phase: 'subiendo' }
      return batches[0]
    }
    return null
  })
  const fake = { invoke, on: (channel: string, callback: (value: unknown) => void) => { events.set(channel, callback); return () => events.delete(channel) } } as KrobiBridge
  stops.push(setFakeBridgeForTest(fake))
  return {
    invoke,
    push: (batch: UploadBatch) => { batches = [batch]; events.get('upload:changed')?.(batch) },
    auth: () => { batches = []; events.get('auth:changed')?.({ userId: 'beto', hasToken: true }) },
    summary: (second = false): UploadBatch => ({ folder: null, id: second ? 'batch-2' : 'batch-1', phase: 'resumen', files: second ? [file('one', 'ya-estaba', true), file('two', 'por-subir')] : [file('one', 'por-subir')] }),
  }
}
it('native picking → review → summary → upload → done; re-pick skips completed hashes', async () => {
  const fake = fixture()
  render(<><UploadButton signedIn /><UploadHost /></>)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Subir música' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Subir música' }))
  fireEvent.click(screen.getByRole('button', { name: 'Elegir carpeta' }))
  await screen.findByText('Buscando cuáles ya están en el nido…')
  act(() => fake.push(fake.summary()))
  fireEvent.click(screen.getByRole('button', { name: 'Agregar 0 y subir 1' }))
  await screen.findByRole('button', { name: 'Detener' })
  act(() => fake.push({ ...fake.summary(), phase: 'terminado', files: fake.summary().files.map(f => ({ ...f, state: 'agregada', offset: f.bytes })) }))
  fireEvent.click(screen.getByRole('button', { name: 'Listo' }))
  fireEvent.click(screen.getByRole('button', { name: 'Subir música' }))
  fireEvent.click(screen.getByRole('button', { name: 'Elegir carpeta' }))
  await screen.findByText('Buscando cuáles ya están en el nido…')
  act(() => fake.push(fake.summary(true)))
  fireEvent.click(screen.getByRole('button', { name: 'Agregar 1 y subir 1' }))
  await waitFor(() => expect(fake.invoke).toHaveBeenCalledWith('upload:start', { id: 'batch-2', duplicates: 'use-nest' }))
  const requests = JSON.stringify(fake.invoke.mock.calls)
  expect(requests).not.toMatch(/ArrayBuffer|Uint8Array|bearer|token|path/)
  act(() => fake.auth())
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})
it('opens a finished batch from Trabajos without depending on Library being mounted', async () => {
  const fake = fixture()
  render(<UploadHost />)
  act(() => fake.push({ ...fake.summary(), phase: 'terminado' }))
  act(() => openUpload('batch-1'))
  await screen.findByRole('dialog', { name: 'Subir música' })
  expect(screen.getByRole('button', { name: 'Listo' })).toBeInTheDocument()
})
