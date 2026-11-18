import bootstrapHtml from '../../index.html?raw'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsProvider, useSettings } from '@state/SettingsContext'

const retired = ['picnic', 'baker', 'ocean', 'tropical', 'matcha']

function Probe() {
  const { theme, mode, setMode } = useSettings()
  return <><output>{theme}:{mode}</output><button onClick={() => setMode('night')}>Noche</button></>
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.mode
  vi.restoreAllMocks()
})

describe('Paper migration', () => {
  for (const saved of retired) {
    for (const mode of ['light', 'dark', 'night']) {
      it(`opens local ${saved} as Paper and keeps ${mode}`, () => {
        localStorage.setItem('theme', saved)
        localStorage.setItem('krobi.mode', mode)
        render(<SettingsProvider><Probe /></SettingsProvider>)
        expect(screen.getByRole('status')).toHaveTextContent(`paper:${mode}`)
        expect(document.documentElement).toHaveAttribute('data-theme', 'paper')
        expect(document.documentElement).toHaveAttribute('data-mode', mode)
        expect(localStorage.getItem('theme')).toBeNull()
        expect(localStorage.getItem('krobi.mode')).toBe(mode)
      })

      it(`opens native ${saved} as Paper and keeps ${mode}`, async () => {
        const setTheme = vi.fn().mockResolvedValue({ ok: true })
        let hydrate: (theme: string) => void
        vi.stubGlobal('desktopAPI', { getTheme: () => new Promise<string>(resolve => { hydrate = resolve }), setTheme })
        localStorage.setItem('krobi.mode', mode)
        render(<SettingsProvider><Probe /></SettingsProvider>)
        expect(screen.getByRole('status')).toHaveTextContent(`paper:${mode}`)
        await act(async () => { hydrate(saved) })
        await waitFor(() => expect(setTheme).toHaveBeenCalledWith('paper'))
        expect(screen.getByRole('status')).toHaveTextContent(`paper:${mode}`)
        expect(document.documentElement).toHaveAttribute('data-theme', 'paper')
        expect(localStorage.getItem('theme')).toBeNull()
        expect(localStorage.getItem('krobi.mode')).toBe(mode)
      })
    }
  }

  it('continues to persist mode changes', () => {
    render(<SettingsProvider><Probe /></SettingsProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Noche' }))
    expect(localStorage.getItem('krobi.mode')).toBe('night')
    expect(document.documentElement).toHaveAttribute('data-mode', 'night')
  })

  it('reads only supported preferences and leaves unknown saved addresses alone', () => {
    // A stub storage, because whether a spy on the real one sees calls
    // depends on the Node version's Storage implementation.
    const saved = new Map([['legacy.address', 'not-an-address'], ['krobi.mode', 'dark']])
    const read = vi.fn((key: string) => saved.get(key) ?? null)
    vi.stubGlobal('localStorage', {
      getItem: read,
      setItem: (key: string, value: string) => { saved.set(key, value) },
      removeItem: (key: string) => { saved.delete(key) },
    })
    render(<SettingsProvider><Probe /></SettingsProvider>)
    expect(screen.getByRole('status')).toHaveTextContent('paper:dark')
    expect(read.mock.calls).toEqual([['krobi.mode']])
    expect(saved.get('legacy.address')).toBe('not-an-address')
  })

  it('applies Paper before paint and follows player-window mode storage events', () => {
    const bootstrap = bootstrapHtml.match(/<script>([\s\S]*?)<\/script>/)![1]
    for (const saved of retired) {
      localStorage.setItem('theme', saved)
      localStorage.setItem('krobi.mode', 'dark')
      // Use the real inline bootstrap in jsdom's window.
      window.eval(bootstrap)
      expect(document.documentElement).toHaveAttribute('data-theme', 'paper')
      expect(document.documentElement).toHaveAttribute('data-mode', 'dark')
      expect(localStorage.getItem('theme')).toBeNull()
      localStorage.setItem('krobi.mode', 'night')
      window.dispatchEvent(new StorageEvent('storage', { key: 'krobi.mode' }))
      expect(document.documentElement).toHaveAttribute('data-mode', 'night')
    }
  })
})
