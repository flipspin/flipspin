import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import PortraitTabBar from './PortraitTabBar'

describe('PortraitTabBar', () => {
  it('draws the five pages and Settings, marking only the active page', () => {
    render(<PortraitTabBar activePage="albums" onSelect={() => {}} onOpenSettings={() => {}} />)

    const names = screen.getAllByRole('button').map((b) => b.textContent)
    expect(names).toEqual(['Inicio', 'Explorar', 'Biblioteca', 'Playlists', 'Ajustes'])

    expect(screen.getByRole('button', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Inicio' })).not.toHaveAttribute('aria-current')
  })

  it('reports the page key, not the label, and opens settings separately', async () => {
    const onSelect = vi.fn()
    const onOpenSettings = vi.fn()
    render(<PortraitTabBar activePage="home" onSelect={onSelect} onOpenSettings={onOpenSettings} />)

    await userEvent.click(screen.getByRole('button', { name: 'Explorar' }))
    expect(onSelect).toHaveBeenCalledWith('dashboard')

    await userEvent.click(screen.getByRole('button', { name: 'Ajustes' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    // Settings is a door, not a page: it never asks to become the active tab.
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})

describe('usePortrait', () => {
  const original = window.matchMedia

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: original })
    vi.resetModules()
  })

  async function load(matches: boolean) {
    const listeners = new Set<() => void>()
    const mq = {
      matches,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue(mq),
    })
    const { usePortrait } = await import('../usePortrait')
    return {
      usePortrait,
      turn(next: boolean) {
        mq.matches = next
        listeners.forEach((cb) => cb())
      },
    }
  }

  it('reads orientation, not width, and follows the window as it turns', async () => {
    const { usePortrait, turn } = await load(true)
    function Probe() {
      return <span>{usePortrait() ? 'portrait' : 'landscape'}</span>
    }
    render(<Probe />)
    expect(screen.getByText('portrait')).toBeInTheDocument()

    const { act } = await import('@testing-library/react')
    act(() => turn(false))
    expect(screen.getByText('landscape')).toBeInTheDocument()
    expect(window.matchMedia).toHaveBeenCalledWith('(orientation: portrait)')
  })

  it('is landscape where matchMedia does not exist', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
    const { usePortrait } = await import('../usePortrait')
    function Probe() {
      return <span>{usePortrait() ? 'portrait' : 'landscape'}</span>
    }
    render(<Probe />)
    expect(screen.getByText('landscape')).toBeInTheDocument()
  })
})
