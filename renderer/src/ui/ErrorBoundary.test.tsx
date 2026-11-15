/**
 * These render real trees and drive them with clicks, because the only claim
 * worth making about a boundary is "the window is not blank and the user can
 * get somewhere". Asserting that `componentDidCatch` ran would prove none of it.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from './ErrorBoundary'

beforeEach(() => {
  // React prints the caught error, and so does the logger with no bridge. Both
  // are expected here; the noise would otherwise bury a real failure.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

function Boom(): React.JSX.Element {
  throw new Error('la carátula no existe')
}

describe('ErrorBoundary', () => {
  it('catches a child that throws and leaves the rest of the app working', async () => {
    const user = userEvent.setup()

    function App(): React.JSX.Element {
      const [count, setCount] = useState(0)
      return (
        <>
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            Reproducidas: {count}
          </button>
          <ErrorBoundary area="la biblioteca">
            <Boom />
          </ErrorBoundary>
        </>
      )
    }

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Algo se rompió en la biblioteca' })).toBeTruthy()

    // The part of the app outside the boundary is still live and interactive.
    await user.click(screen.getByRole('button', { name: 'Reproducidas: 0' }))
    expect(screen.getByRole('button', { name: 'Reproducidas: 1' })).toBeTruthy()
  })

  it('shows the failure verbatim so it can be pasted into a report', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByText('la carátula no existe')).toBeTruthy()
  })

  it('recovers the real screen when the user retries', async () => {
    const user = userEvent.setup()

    // The switch is flipped from outside the component, never inside render.
    // React re-invokes a throwing render while it builds the component stack, so
    // a component that "fails only the first time" quietly succeeds on that
    // second attempt and the boundary is never seen.
    let offline = true

    function Library(): React.JSX.Element {
      if (offline) throw new Error('la conexión se cayó')
      return <p>Tu biblioteca: 178 álbumes</p>
    }

    render(
      <ErrorBoundary>
        <Library />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading', { name: 'Algo se rompió en esta pantalla' })).toBeTruthy()

    offline = false
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))

    expect(screen.getByText('Tu biblioteca: 178 álbumes')).toBeTruthy()
  })

  it('sends the user home when retrying is not the answer', async () => {
    const user = userEvent.setup()

    function App(): React.JSX.Element {
      const [screenName, setScreenName] = useState<'biblioteca' | 'inicio'>('biblioteca')
      if (screenName === 'inicio') return <h1>Inicio</h1>
      return (
        <ErrorBoundary onReturnHome={() => setScreenName('inicio')}>
          <Boom />
        </ErrorBoundary>
      )
    }

    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Volver al inicio' }))

    expect(screen.getByRole('heading', { name: 'Inicio' })).toBeTruthy()
  })

  it('stops offering a retry once retrying has clearly stopped helping', async () => {
    const user = userEvent.setup()

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))

    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull()
    // The way out that does not depend on the broken subtree is still there.
    expect(screen.getByRole('button', { name: 'Recargar la aplicación' })).toBeTruthy()
  })

  it('clears itself when the reset keys change, so navigating away is enough', async () => {
    const user = userEvent.setup()

    function App(): React.JSX.Element {
      const [route, setRoute] = useState('biblioteca')
      return (
        <>
          <button type="button" onClick={() => setRoute('playlists')}>
            Ir a playlists
          </button>
          <ErrorBoundary resetKeys={[route]}>
            {route === 'biblioteca' ? <Boom /> : <p>Tus playlists</p>}
          </ErrorBoundary>
        </>
      )
    }

    render(<App />)
    expect(screen.getByRole('heading', { name: 'Algo se rompió en esta pantalla' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Ir a playlists' }))

    expect(screen.getByText('Tus playlists')).toBeTruthy()
  })

  it('falls back to a screen with no dependencies when the fallback itself crashes', () => {
    render(
      <ErrorBoundary
        fallback={() => {
          throw new Error('el fallback también depende del contexto roto')
        }}
      >
        <Boom />
      </ErrorBoundary>,
    )

    expect(
      screen.getByText('La aplicación no puede mostrar esta pantalla. Recarga para volver a empezar.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Recargar la aplicación' })).toBeTruthy()
  })
})
