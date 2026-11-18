/**
 * Proves the composition, which is the part that a per-module test cannot see:
 * a screen can crash and the app can still talk to the user afterwards.
 */

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UiProvider } from './UiProvider'
import { dismissAllNotifications, notify } from './notifications'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  dismissAllNotifications()
})

function Boom(): React.JSX.Element {
  throw new Error('la vista de álbum se rompió')
}

describe('UiProvider', () => {
  it('keeps the notification surface alive through a crash', () => {
    render(
      <UiProvider>
        <Boom />
      </UiProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Algo se rompió en esta pantalla' })).toBeTruthy()

    // Background work that was already in flight can still report. This only
    // holds because the boundary sits *inside* the providers, not around them.
    act(() => {
      notify({ level: 'error', message: 'La descarga en curso también falló' })
    })
    expect(screen.getByText('La descarga en curso también falló')).toBeTruthy()
  })
})
