import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import css from './page-strip.css?raw'
import { setLanguage } from '../i18n'
import { AcquisitionRefused } from '../acquisition/api'

const me = { isOwner: true }
const install = vi.fn()
const installState = { busy: false, failed: false, succeeded: false, cause: null as string | null, job: undefined as { phase?: string } | undefined, install }
let installed = false

vi.mock('../data', () => ({ useCurrentUser: () => ({ data: me }) }))
vi.mock('../settings/sourceInstall', () => ({
  useKnownSources: () => ({ data: { sources: [{ id: 'youtube', name: 'YouTube', facts: [], location: 'x', installed }] } }),
  useSourceInstall: () => installState,
}))

import { AcquireBar } from './AcquireBar'

const noSources = () => new AcquisitionRefused('Sin fuente de audio', 'no-sources')
const strip = () => screen.getByTestId('message-strip')

beforeEach(() => {
  setLanguage('es')
  me.isOwner = true
  installed = false
  Object.assign(installState, { busy: false, failed: false, succeeded: false, cause: null, job: undefined })
  install.mockReset()
})

describe('message strip above tables', () => {
  it('reserves a fixed height in the stylesheet, so showing or clearing a message never moves the table', () => {
    expect(css).toMatch(/\.page-strip\s*\{[^}]*\bheight:\s*36px/)
    expect(css).not.toMatch(/\.page-strip\s*\{[^}]*min-height/)
    const view = render(<AcquireBar acquisition={{ error: null }} />)
    const empty = strip()
    expect(empty).toBeEmptyDOMElement()
    view.rerender(<AcquireBar acquisition={{ error: new Error('Sin espacio en el nido') }} />)
    expect(strip()).toBe(empty)
    view.rerender(<AcquireBar acquisition={{ error: null }} />)
    expect(strip()).toBe(empty)
    expect(empty).toBeEmptyDOMElement()
  })

  it('says a generic failure once, never "Could not add. Could not add."', () => {
    render(<AcquireBar acquisition={{ error: new Error('No se pudo agregar.') }} />)
    expect(strip().textContent).toBe('No se pudo agregar.')
  })

  it('offers the owner Install YouTube, then replays the refused add when the install succeeds', async () => {
    const resumeBlocked = vi.fn()
    const view = render(<AcquireBar acquisition={{ error: noSources(), resumeBlocked, dismissError: vi.fn() }} />)
    expect(strip()).toHaveTextContent('Sin fuente de audio')
    await userEvent.click(screen.getByRole('button', { name: 'Instalar YouTube' }))
    expect(install).toHaveBeenCalledWith({ id: 'youtube' })
    Object.assign(installState, { busy: true, job: { phase: 'build' } })
    view.rerender(<AcquireBar acquisition={{ error: noSources(), resumeBlocked, dismissError: vi.fn() }} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
    Object.assign(installState, { busy: false, succeeded: true })
    await act(async () => { view.rerender(<AcquireBar acquisition={{ error: noSources(), resumeBlocked, dismissError: vi.fn() }} />) })
    expect(resumeBlocked).toHaveBeenCalledTimes(1)
    view.rerender(<AcquireBar acquisition={{ error: null, resumeBlocked }} />)
    expect(strip()).toHaveTextContent('YouTube instalado')
  })

  it('sends the owner to Engines to turn on an installed source, never reinstalling it', async () => {
    installed = true
    const opened = vi.fn()
    window.addEventListener('krobi-show-settings', opened)
    render(<AcquireBar acquisition={{ error: noSources(), dismissError: vi.fn() }} />)
    expect(screen.queryByRole('button', { name: 'Instalar YouTube' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Activar' }))
    expect(install).not.toHaveBeenCalled()
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'sources-audio' })
    window.removeEventListener('krobi-show-settings', opened)
  })

  it('tells a member who can install, with no install button', () => {
    me.isOwner = false
    render(<AcquireBar acquisition={{ error: noSources(), dismissError: vi.fn() }} />)
    expect(strip()).toHaveTextContent('Pídele a un admin que instale una.')
    expect(screen.queryByRole('button', { name: 'Instalar YouTube' })).toBeNull()
  })

  it('names a failed install by its cause, with Retry, and Not now dismisses', async () => {
    Object.assign(installState, { failed: true, cause: 'no-network' })
    const dismissError = vi.fn()
    render(<AcquireBar acquisition={{ error: noSources(), dismissError }} />)
    expect(strip()).toHaveTextContent('No se pudo instalar YouTube.El nido no tiene conexión a internet.')
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(install).toHaveBeenCalledWith({ id: 'youtube' })
    await userEvent.click(screen.getByRole('button', { name: 'Ahora no' }))
    expect(dismissError).toHaveBeenCalled()
  })
})
