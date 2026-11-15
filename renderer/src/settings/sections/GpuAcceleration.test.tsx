import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MacEngineStatus, AddonStatus } from '../../lib/ipc'
import type { useAddonManagement } from './useAddonManagement'
import { GpuAcceleration } from './GpuAcceleration'

function show(gpu: Partial<AddonStatus> = {}, options = {}) {
  const act = vi.fn()
  const status = { addons: { gpu: { installed: false, ready: false, sizeBytes: null, available: true, card: 'NVIDIA test GPU', downloadBytes: 2_000_000_000, ...gpu } }, installing: null } as MacEngineStatus
  const management = { status, act, busy: false, prerequisite: null, unavailable: null, ...options } as unknown as ReturnType<typeof useAddonManagement>
  render(<GpuAcceleration management={management} />)
  return act
}

describe('GPU acceleration row', () => {
  it('shows detected card and size, and installs through the gpu target', () => {
    const act = show()
    expect(screen.getByText(/NVIDIA test GPU/)).toHaveTextContent('2 GB')
    fireEvent.click(screen.getByRole('button', { name: 'Instalar' }))
    expect(act).toHaveBeenCalledWith('gpu', false)
  })
  it('removes the installed pack through the same target', () => {
    const act = show({ installed: true, ready: true, sizeBytes: 3_000_000_000 })
    expect(screen.getByText('Instalada')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Quitar' }))
    expect(act).toHaveBeenCalledWith('gpu', true)
  })
  it('shows MLX included without an install or remove action', () => {
    show({ installed: true, ready: true, included: true })
    expect(screen.getByText('MLX')).toBeVisible()
    expect(screen.getByText('Incluida')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it.each(['No supported NVIDIA GPU detected', 'NVIDIA driver 580 or newer required', 'CUDA 13 requires Turing or newer'])('unavailable reason is only in a tooltip: %s', reason => {
    show({ available: false, reason })
    expect(screen.getByText('No disponible')).toHaveAttribute('title', reason)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('shows MLX included on a supported Mac before the engine is installed', () => {
    show({}, { computer: { isMac: true }, status: { supported: true, installed: false } })
    expect(screen.getByText('MLX')).toBeVisible()
    expect(screen.getByText('Incluida')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('waits for the base engine and shared install lane', () => {
    show({}, { prerequisite: 'Instala primero el motor' })
    expect(screen.getByRole('button', { name: 'Instalar' })).toBeDisabled()
  })
})
