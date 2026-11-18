/** Compare rendered modules with an independently encoded payload so geometry,
 * quiet-zone and error-correction regressions cannot hide in a snapshot. */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { create } from 'qrcode'

import { QrCode } from './QrCode'
import { buildAccessLink } from './accessLink'

const SERVER = 'http://192.0.2.10:8000'
const TOKEN = 'r4nd0m-t0ken_value'

/** Every dark module of `payload`, as `row,col`; built here, not imported. */
function expectedModules(payload: string): Set<string> {
  const { modules } = create(payload, { errorCorrectionLevel: 'Q' })
  const dark = new Set<string>()
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col) === 1) dark.add(`${row},${col}`)
    }
  }
  return dark
}

/** The same set, recovered from the path the component rendered. */
function renderedModules(path: string, quietZone: number): Set<string> {
  const dark = new Set<string>()
  for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const x = Number(match[1])
    const y = Number(match[2])
    const run = Number(match[3])
    for (let i = 0; i < run; i += 1) dark.add(`${y - quietZone},${x - quietZone + i}`)
  }
  return dark
}

function pathOf(container: HTMLElement): string {
  const path = container.querySelector('svg path')?.getAttribute('d')
  expect(path).toBeTruthy()
  return path as string
}

describe('QrCode', () => {
  it('encodes exactly the pairing payload for a known server and token', () => {
    const payload = buildAccessLink(SERVER, TOKEN)
    expect(payload).toBe(
      `krobi://acceso?server=http%3A%2F%2F192.0.2.10%3A8000&access_token=${TOKEN}`,
    )

    const { container } = render(<QrCode payload={payload as string} />)
    const drawn = renderedModules(pathOf(container), 4)

    expect(drawn).toEqual(expectedModules(payload as string))
    expect(drawn.size).toBeGreaterThan(100)
  })

  it('encodes a different token differently', () => {
    // The negative control. Without it, a component that drew a constant would
    // satisfy every other assertion in this file.
    const one = buildAccessLink(SERVER, TOKEN) as string
    const two = buildAccessLink(SERVER, 'a-completely-different-token') as string

    const first = render(<QrCode payload={one} />)
    const firstPath = pathOf(first.container)
    first.unmount()

    const second = render(<QrCode payload={two} />)
    expect(pathOf(second.container)).not.toBe(firstPath)
  })

  it('keeps the specified four-module quiet zone', () => {
    // Dropping it is the classic way to ship a code that scans in a design tool
    // and not on a desk: a decoder needs the blank border to find the symbol.
    const payload = buildAccessLink(SERVER, TOKEN) as string
    const { container } = render(<QrCode payload={payload} />)
    const svg = container.querySelector('svg') as SVGSVGElement
    const { modules } = create(payload, { errorCorrectionLevel: 'Q' })

    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${modules.size + 8} ${modules.size + 8}`)
  })

  it('never writes the payload into the document', () => {
    // The payload is a live credential. Nothing rendered here; no alt, no
    // title, no aria-label, no data attribute; may carry it.
    const payload = buildAccessLink(SERVER, TOKEN) as string
    const { container } = render(<QrCode payload={payload} />)

    expect(container.innerHTML).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain('krobi://')
    expect(container.textContent).toBe('')
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Código QR para vincular el teléfono',
    )
  })

  it("renders large enough to scan from arm's length", () => {
    const payload = buildAccessLink(SERVER, TOKEN) as string
    const { container } = render(<QrCode payload={payload} />)
    const svg = container.querySelector('svg') as SVGSVGElement

    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(280)
  })
})
