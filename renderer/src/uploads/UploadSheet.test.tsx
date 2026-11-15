import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UploadBatch, UploadItem } from '../lib/ipc'
import { UploadSheet } from './UploadSheet'

const file = (state: UploadItem['state'], i = 0): UploadItem => ({ id: String(i), sha256: String(i), name: `Song ${i}.flac`, bytes: 1000, offset: state === 'agregada' ? 1000 : 0, state, reason: null, duplicate: false })
const actions = () => ({ onPick: vi.fn(), onStart: vi.fn(), onStop: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() })
function batch(phase: UploadBatch['phase'], files: UploadItem[] = []): UploadBatch { return { folder: null, id: 'batch', phase, files, reviewed: 4, total: 10 } }

describe('upload sheet', () => {
  it('offers native folder and file pickers during selection', () => {
    const props = actions()
    render(<UploadSheet batch={null} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Elegir carpeta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Elegir archivos' }))
    expect(props.onPick.mock.calls).toEqual([['folder'], ['files']])
    expect(screen.getByText('Arrastra canciones o carpetas')).toBeInTheDocument()
  })
  it('shows hashing progress during review', () => {
    render(<UploadSheet batch={batch('revisando')} {...actions()} />)
    expect(screen.getByText('4 de 10')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0.4')
  })
  it('asks once for the batch in the summary and names exactly what will be sent', () => {
    const props = actions()
    const files = [file('ya-estaba'), { ...file('por-subir', 1), duplicate: true }, { ...file('no-apta', 2), reason: 'no-es-audio' as const }]
    render(<UploadSheet batch={batch('resumen', files)} {...props} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Conservar ambas' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agregar 1 y subir 1' }))
    expect(props.onStart).toHaveBeenCalledWith('keep-both')
    expect(screen.getByText('no aptas')).toBeInTheDocument()
  })
  it('exposes bytes, the current file and "Stop" during upload', () => {
    const props = actions()
    render(<UploadSheet batch={{ ...batch('subiendo', [file('agregada'), file('subiendo', 1)]), current: 'Album/Song.flac' }} {...props} />)
    expect(screen.getByText('1 de 2')).toBeInTheDocument()
    expect(screen.getByText(/subidas ·/)).toHaveTextContent('1 KB')
    expect(screen.getByText('Album/Song.flac').tagName).toBe('CODE')
    fireEvent.click(screen.getByRole('button', { name: 'Detener' }))
    expect(props.onStop).toHaveBeenCalledOnce()
  })
  it('groups failures by kind and retries failures after completion', () => {
    const props = actions()
    render(<UploadSheet batch={batch('terminado', [file('agregada'), { ...file('fallida', 1), reason: 'fallo-subida' }, { ...file('no-apta', 2), reason: 'archivo-danado' }])} {...props} />)
    expect(screen.getByText('Falló la subida')).toBeInTheDocument()
    expect(screen.getByText('Archivo dañado')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(props.onRetry).toHaveBeenCalledOnce()
  })
  it('groups the detailed reasons and excludes permanent failures from Retry', () => {
    const props = actions()
    const files = (['not-audio', 'changed', 'unreadable', 'damaged'] as const).map((reason, index) => ({ ...file('fallida', index), reason }))
    const { rerender } = render(<UploadSheet batch={batch('terminado', files)} {...props} />)
    for (const word of ['No es audio', 'Cambió durante la subida', 'No se puede leer', 'Dañado']) expect(screen.getByText(word)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeEnabled()
    rerender(<UploadSheet batch={batch('terminado', files.filter(item => item.reason === 'not-audio' || item.reason === 'damaged'))} {...props} />)
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull()
  })
  it('re-picking a folder skips already completed files in the new summary', () => {
    const props = actions()
    const { rerender } = render(<UploadSheet batch={batch('terminado', [file('agregada')])} {...props} />)
    rerender(<UploadSheet batch={{ ...batch('resumen', [file('ya-estaba'), file('por-subir', 1)]), id: 'repicked' }} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agregar 1 y subir 1' }))
    expect(props.onStart).toHaveBeenCalledWith('use-nest')
  })
})
