/**
 * "Send to → VLC": asked the first time, saved
 * once it works, sent at once after that, and the same card on a failure.
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { VlcSendCard } from './VlcSendCard'
import { resetVlcForTest, vlcMenuItems } from './vlcSend'

const SONGS = [{ path: '/m/A/1.mp3' }, { path: '/m/A/2.mp3' }, { path: '/m/A/3.mp3' }]

let fake: FakeSettings | null = null
afterEach(() => {
  fake?.restore()
  fake = null
  resetVlcForTest()
})

function start(answers: number[]) {
  const queue = [...answers]
  fake = installFakeSettings({
    respond: (r) => (r.pathname === '/api/upload-selected-vlc' ? { status: queue.shift() ?? 200, json: { success: true } } : undefined),
  })
  const setVlcIp = vi.fn()
  render(<VlcSendCard setVlcIp={setVlcIp} />)
  return { setVlcIp }
}

describe('Enviar a → VLC', () => {
  it('with no address the item is «VLC…» and opens the card', async () => {
    start([])
    const items = vlcMenuItems(SONGS, '')
    expect(items.map((item) => item.label)).toEqual(['VLC…'])
    act(() => items[0].onClick())
    expect(await screen.findByLabelText('Dirección')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Enviar 3 canciones' })).toBeDisabled()
  })

  it('a failure keeps the card with the reason and «Reintentar»; a success saves the address', async () => {
    const { setVlcIp } = start([500, 200])
    act(() => vlcMenuItems(SONGS, '')[0].onClick())
    await userEvent.type(await screen.findByLabelText('Dirección'), '192.168.1.50')
    await userEvent.click(screen.getByRole('button', { name: 'Enviar 3 canciones' }))
    expect(await screen.findByText('Sin respuesta en 192.168.1.50')).toBeInTheDocument()
    expect(setVlcIp).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByText('3 canciones enviadas a VLC.')).toBeInTheDocument()
    expect(setVlcIp).toHaveBeenCalledWith('192.168.1.50')
    expect(screen.queryByLabelText('Dirección')).not.toBeInTheDocument()
    expect(fake?.requests.at(-1)?.body).toEqual({ paths: SONGS.map((s) => s.path), vlc_ip: '192.168.1.50' })
  })

  it('with a saved address it sends at once, and can change it', async () => {
    start([200])
    const items = vlcMenuItems(SONGS, '192.168.1.50')
    expect(items.map((item) => item.label)).toEqual(['VLC · 192.168.1.50', 'Cambiar dirección de VLC…'])
    act(() => items[0].onClick())
    expect(await screen.findByText('3 canciones enviadas a VLC.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Dirección')).not.toBeInTheDocument()

    act(() => items[1].onClick())
    expect(await screen.findByLabelText('Dirección')).toHaveValue('192.168.1.50')
  })

  it('a saved address that stops answering reopens the card', async () => {
    start([500])
    act(() => vlcMenuItems(SONGS, '10.0.0.9')[0].onClick())
    expect(await screen.findByText('Sin respuesta en 10.0.0.9')).toBeInTheDocument()
  })
})
