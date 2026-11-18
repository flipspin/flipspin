/**
 * Driven the way the app drives it: a button raises a notification, the user
 * reads it and dismisses it. The assertions are about what is on screen and what
 * a screen reader would be told, which is the entire product of this module.
 */

import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotificationsProvider, dismissAllNotifications, notify, useNotifications } from './notifications'
import type { NotifyOptions } from './notifications'

afterEach(() => {
  // Module-level state: the buffer survives an unmounted provider on purpose,
  // so it has to be cleared between tests.
  dismissAllNotifications()
  vi.useRealTimers()
})

/** A button per notification, the way a screen would wire one up. */
function Screen({ botones }: { botones: Array<[string, NotifyOptions]> }): React.JSX.Element {
  const { notify: raise } = useNotifications()
  return (
    <>
      {botones.map(([label, options]) => (
        <button key={label} type="button" onClick={() => raise(options)}>
          {label}
        </button>
      ))}
    </>
  )
}

function renderScreen(botones: Array<[string, NotifyOptions]>): void {
  render(
    <NotificationsProvider>
      <Screen botones={botones} />
    </NotificationsProvider>,
  )
}

describe('notifications', () => {
  it('shows a message the user can read after an action', async () => {
    const user = userEvent.setup()
    renderScreen([['Descargar', { level: 'success', message: 'Se descargó «Kind of Blue»' }]])

    await user.click(screen.getByRole('button', { name: 'Descargar' }))

    expect(screen.getByText('Se descargó «Kind of Blue»')).toBeTruthy()
  })

  it('keeps both live regions mounted before anything has been raised', () => {
    renderScreen([])

    // A live region has to exist before its content arrives, or the mutation
    // is not observed and nothing is announced. That is why these are asserted
    // on an empty screen.
    expect(screen.getByRole('list', { name: 'Notificaciones' }).getAttribute('aria-live')).toBe('polite')
    expect(screen.getByRole('list', { name: 'Alertas' }).getAttribute('aria-live')).toBe('assertive')
  })

  it('announces an error assertively and a confirmation politely', async () => {
    const user = userEvent.setup()
    renderScreen([
      ['Fallar', { level: 'error', message: 'No se pudo conectar con el servidor' }],
      ['Guardar', { level: 'success', message: 'Lista guardada' }],
    ])

    await user.click(screen.getByRole('button', { name: 'Fallar' }))
    await user.click(screen.getByRole('button', { name: 'Guardar' }))

    const alertas = within(screen.getByRole('list', { name: 'Alertas' }))
    const avisos = within(screen.getByRole('list', { name: 'Notificaciones' }))
    expect(alertas.getByText('No se pudo conectar con el servidor')).toBeTruthy()
    expect(avisos.getByText('Lista guardada')).toBeTruthy()
  })

  it('stacks several at once instead of replacing them', async () => {
    const user = userEvent.setup()
    renderScreen([
      ['Uno', { level: 'error', message: 'Falló la pista 1' }],
      ['Dos', { level: 'error', message: 'Falló la pista 2' }],
      ['Tres', { level: 'error', message: 'Falló la pista 3' }],
    ])

    await user.click(screen.getByRole('button', { name: 'Uno' }))
    await user.click(screen.getByRole('button', { name: 'Dos' }))
    await user.click(screen.getByRole('button', { name: 'Tres' }))

    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('folds a repeated message into a count rather than three identical toasts', async () => {
    const user = userEvent.setup()
    renderScreen([['Fallar', { level: 'error', message: 'No se pudo conectar con el servidor' }]])

    await user.click(screen.getByRole('button', { name: 'Fallar' }))
    await user.click(screen.getByRole('button', { name: 'Fallar' }))

    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Error ×2')).toBeTruthy()
  })

  it('queues the overflow and says how much is waiting', async () => {
    const user = userEvent.setup()
    renderScreen([
      ['Uno', { level: 'error', message: 'Falló la pista 1' }],
      ['Dos', { level: 'error', message: 'Falló la pista 2' }],
      ['Tres', { level: 'error', message: 'Falló la pista 3' }],
      ['Cuatro', { level: 'error', message: 'Falló la pista 4' }],
    ])

    for (const label of ['Uno', 'Dos', 'Tres', 'Cuatro']) {
      await user.click(screen.getByRole('button', { name: label }))
    }

    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('1 mensaje más en espera')).toBeTruthy()
    expect(screen.queryByText('Falló la pista 4')).toBeNull()
  })

  it('lets the user dismiss one, which promotes whatever was waiting', async () => {
    const user = userEvent.setup()
    renderScreen([
      ['Uno', { level: 'error', message: 'Falló la pista 1' }],
      ['Dos', { level: 'error', message: 'Falló la pista 2' }],
      ['Tres', { level: 'error', message: 'Falló la pista 3' }],
      ['Cuatro', { level: 'error', message: 'Falló la pista 4' }],
    ])

    for (const label of ['Uno', 'Dos', 'Tres', 'Cuatro']) {
      await user.click(screen.getByRole('button', { name: label }))
    }

    await user.click(screen.getByRole('button', { name: 'Descartar: Falló la pista 1' }))

    expect(screen.queryByText('Falló la pista 1')).toBeNull()
    expect(screen.getByText('Falló la pista 4')).toBeTruthy()
  })

  it('dismisses a transient message on its own', () => {
    vi.useFakeTimers()
    renderScreen([])

    act(() => {
      notify({ level: 'success', message: 'Lista guardada' })
    })
    expect(screen.getByText('Lista guardada')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.queryByText('Lista guardada')).toBeNull()
  })

  it('keeps an error on screen until the user deals with it', () => {
    vi.useFakeTimers()
    renderScreen([])

    act(() => {
      notify({ level: 'error', message: 'No se pudo conectar con el servidor' })
    })

    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(screen.getByText('No se pudo conectar con el servidor')).toBeTruthy()
  })

  it('does not expire a queued message before anyone has seen it', () => {
    vi.useFakeTimers()
    renderScreen([])

    act(() => {
      notify({ level: 'info', message: 'Aviso 1' })
      notify({ level: 'info', message: 'Aviso 2' })
      notify({ level: 'info', message: 'Aviso 3' })
      notify({ level: 'info', message: 'Aviso 4' })
    })

    act(() => {
      vi.advanceTimersByTime(5000)
    })

    // The first three expired; the fourth only started its life when it became
    // visible, so it is still readable rather than already gone.
    expect(screen.getByText('Aviso 4')).toBeTruthy()
  })

  it('offers an action the user can take from the notification', async () => {
    const user = userEvent.setup()
    let reintentos = 0
    renderScreen([])

    act(() => {
      notify({
        level: 'error',
        message: 'No se pudo descargar el álbum',
        action: {
          label: 'Reintentar',
          onSelect: () => {
            reintentos += 1
          },
        },
      })
    })

    await user.click(screen.getByRole('button', { name: 'Reintentar' }))

    expect(reintentos).toBe(1)
    expect(screen.queryByText('No se pudo descargar el álbum')).toBeNull()
  })

  it('delivers a failure raised from non-component code before the UI existed', () => {
    // Exactly the startup case: a query error handler fires while the provider
    // is still mounting. Nothing is lost.
    notify({ level: 'error', message: 'El servidor no respondió al arrancar' })

    renderScreen([])

    expect(screen.getByText('El servidor no respondió al arrancar')).toBeTruthy()
  })
})

it('keeps separate journal actions even when result messages match; Details retains Undo', async () => {
  const details = vi.fn(), undo = vi.fn(), otherUndo = vi.fn()
  renderScreen([
    ['First', { id: 'journal-one', sticky: true, message: 'Changed genre of 29 songs', action: { label: 'Details', onSelect: details, dismiss: false }, secondaryAction: { label: 'Undo', onSelect: undo } }],
    ['Second', { id: 'journal-two', sticky: true, message: 'Changed genre of 29 songs', action: { label: 'Undo second', onSelect: otherUndo } }],
  ])
  await userEvent.click(screen.getByRole('button', { name: 'First' }))
  await userEvent.click(screen.getByRole('button', { name: 'Second' }))
  expect(screen.getAllByText('Changed genre of 29 songs')).toHaveLength(2)
  await userEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(details).toHaveBeenCalledOnce()
  await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(undo).toHaveBeenCalledOnce()
  expect(otherUndo).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Undo second' })).toBeInTheDocument()
})
