// @vitest-environment jsdom
/**
 * The reveal against a nest this computer hosts with no LAN address: the only
 * address there is, is loopback; and a phone scanning it would reach itself.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MintedAccessReveal } from './MintedAccessReveal'
import { PairingProvider } from './PairingProvider'
import type { MintedAccess, PairingGateway } from './types'

const ACCESS = {
  device: { id: 'd1', label: 'iPhone', role: 'member' },
  token: 'r4nd0m-t0ken_value',
} as unknown as MintedAccess

function reveal(serverUrl: string) {
  return render(
    <PairingProvider gateway={{} as PairingGateway} serverUrl={serverUrl} copyText={vi.fn(async () => true)}>
      <MintedAccessReveal access={ACCESS} onDismiss={() => {}} />
    </PairingProvider>,
  )
}

describe('MintedAccessReveal', () => {
  it('says this computer must be on the network instead of drawing a loopback code', () => {
    reveal('http://127.0.0.1:8000')

    expect(screen.getByRole('alert')).toHaveTextContent('Para vincular un teléfono, este equipo debe estar en tu red.')
    // No address to copy either: on the phone, 127.0.0.1 is the phone.
    expect(screen.queryByDisplayValue('http://127.0.0.1:8000')).not.toBeInTheDocument()
  })

  it('draws the code for a LAN address', () => {
    reveal('http://192.168.1.20:8000')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Abre la cámara del teléfono y apunta al código.')).toBeInTheDocument()
  })
})
