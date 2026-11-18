import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowsCaption, hasWindowsCaption } from './WindowControls'

const calls: string[] = []
let maximized = false
let resized: (() => void) | null = null
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: async () => { calls.push('minimize') },
    toggleMaximize: async () => { calls.push('toggleMaximize') },
    close: async () => { calls.push('close') },
    isMaximized: async () => maximized,
    onResized: async (listener: () => void) => { resized = listener; return () => { resized = null } },
  }),
}))

const userAgent = navigator.userAgent
function onWindows(windows: boolean) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: windows ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })
}

describe('WindowsCaption', () => {
  beforeEach(() => { calls.length = 0; maximized = false; (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {} })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
  })

  it('shows only in the desktop app on Windows', () => {
    onWindows(false)
    expect(hasWindowsCaption()).toBe(false)
    const { container } = render(<WindowsCaption />)
    expect(container).toBeEmptyDOMElement()
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
    onWindows(true)
    expect(hasWindowsCaption()).toBe(false)
  })

  it('minimizes, maximizes and closes the window', async () => {
    onWindows(true)
    render(<WindowsCaption />)
    await userEvent.click(await screen.findByRole('button', { name: 'Minimizar' }))
    await userEvent.click(screen.getByRole('button', { name: 'Maximizar' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(calls).toEqual(['minimize', 'toggleMaximize', 'close'])
  })

  it('offers Restore while the window is maximized, however it got there', async () => {
    onWindows(true)
    render(<WindowsCaption />)
    expect(await screen.findByRole('button', { name: 'Maximizar' })).toBeInTheDocument()
    maximized = true
    await act(async () => { resized?.() })
    expect(await screen.findByRole('button', { name: 'Restaurar' })).toBeInTheDocument()
  })
})
