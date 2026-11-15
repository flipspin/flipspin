import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { DataProvider } from '../../data'
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from '../test-support'
import { ToastProvider } from '../parts'
import { DeleteAccount } from './DeleteAccount'

const PERSON = { id: 'u2', label: 'Eduardo', role: 'member' as const, createdAt: null, lastSeenAt: null }
const PREVIEW = { devices: 2, songs: 212, playlists: 3, removable: { count: 38, bytes: 1234567890 }, kept: 174 }
const RESULT = { success: true, user: PERSON, removedSongs: 38, freedBytes: 1234567890, playlists: 'deleted' }
let fake: FakeSettings | undefined
afterEach(async () => { fake?.restore(); await i18n.changeLanguage('es') })

function open({ respond, hold, own = false }: {
  respond?: (request: RecordedRequest) => ResponseSpec | undefined
  hold?: 'preview' | 'delete'
  own?: boolean
} = {}) {
  fake = installFakeSettings({ respond: r => respond?.(r) ?? (r.method === 'DELETE'
    ? { status: 200, json: RESULT }
    : { status: 200, json: PREVIEW }) })
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetch = globalThis.fetch
  if (hold) globalThis.fetch = (async (request: Request) => {
    if ((hold === 'delete' && request.method === 'DELETE') || (hold === 'preview' && request.url.includes('/deletion-preview'))) await gate
    return fetch(request)
  }) as typeof globalThis.fetch
  const onClose = vi.fn()
  const onDeleted = vi.fn()
  const view = render(<DataProvider queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><DeleteAccount person={PERSON} own={own} onClose={onClose} onDeleted={onDeleted} /></ToastProvider>
  </DataProvider>)
  return { ...view, onClose, onDeleted, release }
}

const account = () => screen.getByRole('radio', { name: /Solo la cuenta/ })
const songs = () => screen.getByRole('radio', { name: /La cuenta y sus canciones/ })

describe('desktop delete account', () => {
  it('loads a fresh preview on opening, with ellipses and skeletons, then all facts', async () => {
    const { release, container } = open({ hold: 'preview' })
    expect(screen.getByText('… dispositivos · … canciones · … playlists')).toBeInTheDocument()
    expect(container.querySelectorAll('.zm-skel')).toHaveLength(2)
    expect(account()).toHaveAttribute('aria-checked', 'true')
    expect(songs()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Eliminar cuenta' })).toBeEnabled()
    await act(async () => release())
    await waitFor(() => expect(songs()).toBeEnabled())
    expect(container.querySelector('.da-facts')).toHaveTextContent('2 dispositivos · 212 canciones · 3 playlists')
    expect(account()).toHaveTextContent('212 canciones se quedan en el nido')
    expect(account()).toHaveTextContent('3 playlists pasan a tu cuenta')
    expect(songs()).toHaveTextContent('38 se eliminan · 1,2 GB')
    expect(songs()).toHaveTextContent('174 se quedan · otras cuentas las tienen')
    expect(songs()).toHaveTextContent('3 playlists se eliminan')
    expect(songs().querySelector<HTMLElement>('.zm-progress')!.style.getPropertyValue('--_v')).toBe(`${38 / 212 * 100}%`)
    expect(fake!.requests.some(r => r.pathname === '/api/users/u2/deletion-preview')).toBe(true)
  })

  it('uses real radio buttons, roving tab stops, arrows and Escape', async () => {
    const { onClose } = open()
    await waitFor(() => expect(songs()).toBeEnabled())
    await userEvent.click(account())
    await userEvent.keyboard('{ArrowRight}')
    expect(songs()).toHaveFocus()
    expect(songs()).toHaveAttribute('aria-checked', 'true')
    expect(account()).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('button', { name: 'Eliminar cuenta y 38 canciones' })).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}')
    expect(account()).toHaveFocus()
    await userEvent.keyboard('{End}{Home}{ArrowLeft}')
    expect(songs()).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('disables songs with zero removable files and an accessible reason', async () => {
    open({ respond: () => ({ status: 200, json: { ...PREVIEW, removable: { count: 0, bytes: 0 }, kept: 212 } }) })
    await screen.findByText('0 canciones solo suyas')
    expect(songs()).toBeDisabled()
    expect(songs()).toHaveAccessibleDescription('Eduardo no tiene canciones propias en el nido.')
    await userEvent.click(account())
    await userEvent.keyboard('{ArrowRight}')
    expect(account()).toHaveFocus()
    expect(account()).toHaveAttribute('aria-checked', 'true')
  })

  it.each([404, 500, 'network'] as const)('failed preview (%s) shows the failure word, reason tooltip and retry; account deletion remains available', async status => {
    let failing = true
    open({ respond: () => failing ? status === 'network' ? { networkError: 'offline' } : { status, json: { detail: 'Not Found' } } : undefined })
    const retry = await screen.findByRole('button', { name: 'Reintentar' })
    expect(songs()).toBeDisabled()
    expect(songs()).toHaveTextContent('El nido no respondió')
    expect(within(songs()).getByText('El nido no respondió')).toHaveAttribute('title', 'El nido no respondió, así que no se eliminará ninguna canción')
    expect(songs()).not.toHaveTextContent('—')
    expect(document.querySelector('.da-facts')).toHaveTextContent('Sin datos')
    expect(screen.getByRole('button', { name: 'Eliminar cuenta' })).toBeEnabled()
    failing = false
    await userEvent.click(retry)
    await waitFor(() => expect(songs()).toBeEnabled())
    expect(account()).toHaveAttribute('aria-checked', 'true')
    expect(fake!.requests.filter(r => r.pathname.endsWith('/deletion-preview'))).toHaveLength(2)
  })

  it.each([false, true])('sends songs=%s once, locks all controls until done and reports actual server counts', async withSongs => {
    const { release, onClose, onDeleted } = open({ hold: 'delete', respond: r => r.method === 'DELETE' && !withSongs
      ? { status: 200, json: { ...RESULT, removedSongs: 0, freedBytes: 0, playlists: 'transferred' } } : undefined })
    await waitFor(() => expect(songs()).toBeEnabled())
    if (withSongs) await userEvent.click(songs())
    await userEvent.click(screen.getByRole('button', { name: withSongs ? 'Eliminar cuenta y 38 canciones' : 'Eliminar cuenta' }))
    const dialog = screen.getByRole('dialog')
    expect(screen.getByRole('button', { name: 'Eliminando…' })).toBeDisabled()
    for (const button of within(dialog).getAllByRole('button')) expect(button).toBeDisabled()
    expect(account()).toBeDisabled()
    expect(songs()).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => release())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
    expect(onClose).toHaveBeenCalledOnce()
    expect(fake!.requests.filter(r => r.method === 'DELETE').map(r => r.search)).toEqual([`?songs=${withSongs}`])
    expect(await screen.findByText(withSongs ? 'Cuenta de Eduardo eliminada · 38 canciones eliminadas · 1,2 GB liberados' : 'Cuenta de Eduardo eliminada')).toBeInTheDocument()
    expect(fake!.invocations.some(r => r.channel === 'auth:clear')).toBe(false)
  })

  it('shows the last-admin 422 as one acknowledgement', async () => {
    const { onClose, onDeleted } = open({ respond: r => r.method === 'DELETE' ? { status: 422, json: { detail: 'last owner' } } : undefined })
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar cuenta' }))
    expect(await screen.findByRole('dialog', { name: 'No se puede eliminar tu cuenta' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Es la última cuenta admin del nido: sin ella nadie podría crear ni quitar cuentas.')
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getAllByRole('button')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Entendido' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('keeps a failed delete open for retry and signs out only after its own successful delete', async () => {
    let fail = true
    const { onDeleted } = open({ own: true, respond: r => r.method === 'DELETE' && fail ? { status: 500, json: {} } : undefined })
    expect(screen.getByRole('dialog', { name: '¿Eliminar tu cuenta?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar cuenta' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo eliminar · sigue teniendo acceso')
    expect(onDeleted).not.toHaveBeenCalled()
    expect(fake!.invocations.some(r => r.channel === 'auth:clear')).toBe(false)
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar cuenta' }))
    await waitFor(() => expect(fake!.invocations).toContainEqual({ channel: 'auth:clear', request: undefined }))
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('translates the dialog, plural rules and toast in English at render time', async () => {
    await i18n.changeLanguage('en')
    const { container } = open({ respond: r => r.method === 'DELETE' ? { status: 200, json: { ...RESULT, removedSongs: 1, freedBytes: 4200000 } }
      : { status: 200, json: { devices: 1, songs: 1, playlists: 1, removable: { count: 1, bytes: 4200000 }, kept: 0 } } })
    const option = await screen.findByRole('radio', { name: /The account and its songs/ })
    await waitFor(() => expect(option).toBeEnabled())
    expect(container.querySelector('.da-facts')).toHaveTextContent('1 device · 1 song · 1 playlist')
    await userEvent.click(option)
    await userEvent.click(screen.getByRole('button', { name: 'Delete account and 1 song' }))
    expect(await screen.findByText('Eduardo’s account deleted · 1 song deleted · 4.2 MB freed')).toBeInTheDocument()
  })
})
