/** Exercise confirmation through an awaiting caller and verify that provider teardown settles pending requests. */

import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfirmProvider, confirmAction, useConfirm } from './confirm'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A destructive action guarded by a confirmation, as a screen would write it. */
function Playlist(): React.JSX.Element {
  const confirm = useConfirm()
  const [status, setStatus] = useState('Playlist: Jazz de noche')

  async function removePlaylist(): Promise<void> {
    const ok = await confirm({
      title: '¿Eliminar la playlist «Jazz de noche»?',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    })
    setStatus(ok ? 'Lista eliminada' : 'Playlist: Jazz de noche')
  }

  return (
    <>
      <button type="button" onClick={() => void removePlaylist()}>
        Eliminar playlist
      </button>
      <p>{status}</p>
    </>
  )
}

function renderPlaylist(): void {
  render(
    <ConfirmProvider>
      <Playlist />
    </ConfirmProvider>,
  )
}

describe('confirm', () => {
  it('asks before a destructive action and carries it out when the user agrees', async () => {
    const user = userEvent.setup()
    renderPlaylist()

    await user.click(screen.getByRole('button', { name: 'Eliminar playlist' }))

    const dialogo = within(screen.getByRole('alertdialog'))
    expect(screen.getByRole('alertdialog').getAttribute('aria-modal')).toBe('true')
    expect(dialogo.getByRole('heading', { name: '¿Eliminar la playlist «Jazz de noche»?' })).toBeTruthy()
    expect(dialogo.getByText('Esta acción no se puede deshacer.')).toBeTruthy()

    await user.click(dialogo.getByRole('button', { name: 'Eliminar' }))

    expect(screen.getByText('Lista eliminada')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('leaves everything alone when the user cancels', async () => {
    const user = userEvent.setup()
    renderPlaylist()

    await user.click(screen.getByRole('button', { name: 'Eliminar playlist' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))

    expect(screen.getByText('Playlist: Jazz de noche')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('treats Escape as a no', async () => {
    const user = userEvent.setup()
    renderPlaylist()

    await user.click(screen.getByRole('button', { name: 'Eliminar playlist' }))
    await user.keyboard('{Escape}')

    expect(screen.getByText('Playlist: Jazz de noche')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('opens a destructive dialog on the safe button', async () => {
    const user = userEvent.setup()
    renderPlaylist()

    await user.click(screen.getByRole('button', { name: 'Eliminar playlist' }))

    // A reflexive Enter on a dialog the user did not read should not delete
    // anything, so focus starts on "Cancel".
    expect(document.activeElement).toBe(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
  })

  it('renders a danger text action and focuses Cancelar for a destructive confirm', async () => {
    render(<ConfirmProvider />)
    act(() => { void confirmAction({ title: 'Eliminar', confirmLabel: 'Eliminar', destructive: true }) })
    const dialog = within(screen.getByRole('alertdialog'))
    expect(dialog.getByRole('button', { name: 'Eliminar' })).toHaveClass('k-btn--text', 'k-btn--text-danger')
    expect(dialog.getByRole('button', { name: 'Cancelar' })).toHaveFocus()
  })

  it('returns focus to the control that opened it', async () => {
    const user = userEvent.setup()
    renderPlaylist()

    const opener = screen.getByRole('button', { name: 'Eliminar playlist' })
    await user.click(opener)
    await user.keyboard('{Escape}')

    expect(document.activeElement).toBe(opener)
  })

  it('queues a second question instead of dropping it', async () => {
    const user = userEvent.setup()
    const answers: boolean[] = []

    render(
      <ConfirmProvider>
        <button
          type="button"
          onClick={() => {
            void confirmAction({ title: '¿Borrar la pista?' }).then((value) => answers.push(value))
            void confirmAction({ title: '¿Vaciar la papelera?' }).then((value) => answers.push(value))
          }}
        >
          Preguntar dos veces
        </button>
      </ConfirmProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Preguntar dos veces' }))
    expect(screen.getByRole('heading', { name: '¿Borrar la pista?' })).toBeTruthy()

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar' }))

    // The second question is now the one on screen, still awaiting an answer.
    expect(screen.getByRole('heading', { name: '¿Vaciar la papelera?' })).toBeTruthy()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))

    expect(answers).toEqual([true, false])
  })

  it('settles an open question with a no when the dialog is torn down', async () => {
    const { unmount } = render(<ConfirmProvider />)

    let answer: boolean | 'sin respuesta' = 'sin respuesta'
    act(() => {
      void confirmAction({ title: '¿Eliminar el álbum?' }).then((value) => {
        answer = value
      })
    })
    expect(screen.getByRole('dialog')).toBeTruthy()

    // The leak: without the provider's unmount cleanup the caller awaits this
    // forever, holding whatever it was about to do.
    unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(answer).toBe(false)
  })

  it('answers no rather than hanging when no dialog is mounted at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(confirmAction({ title: '¿Eliminar el álbum?' })).resolves.toBe(false)
  })
})
