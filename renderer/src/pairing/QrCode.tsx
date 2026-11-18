/**
 * Renders pairing QR codes as SVG geometry without exposing the token as text.
 * Inline vectors keep modules sharp at different display scales and work in DOM tests.
 * The payload must never enter titles, labels, data attributes or logs.
 * Error correction Q balances damage tolerance and module size at 320 CSS pixels.
 * Preserve the four-module quiet zone required by QR decoders.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'qrcode'

import { qrFrame } from './styles'

const ERROR_CORRECTION = 'Q'
const QUIET_ZONE = 4
const DEFAULT_SIZE = 320

export interface QrGeometry {
  /** Modules per side, quiet zone included. The SVG's user-space extent. */
  extent: number
  /** An SVG path covering every dark module. */
  path: string
}

/** Expose geometry for payload assertions. Merge horizontal runs to keep SVG path attributes small. */
export function buildQrGeometry(payload: string): QrGeometry {
  const { modules } = create(payload, { errorCorrectionLevel: ERROR_CORRECTION })
  const size = modules.size
  const parts: string[] = []

  for (let row = 0; row < size; row += 1) {
    let col = 0
    while (col < size) {
      if (modules.get(row, col) === 0) {
        col += 1
        continue
      }
      const start = col
      while (col < size && modules.get(row, col) === 1) col += 1
      const run = col - start
      parts.push(`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${run}v1h-${run}z`)
    }
  }

  return { extent: size + QUIET_ZONE * 2, path: parts.join('') }
}

export interface QrCodeProps {
  /**
   * A live credential. It is encoded and thrown away; it is never written to
   * an attribute, and this component must never gain a prop that would print it.
   */
  payload: string
  /** Side length in CSS pixels. See this file's header before shrinking it. */
  size?: number
  /**
   * What a screen reader says. Describes the code, never its contents; reading
   * a token aloud in a shared room is the same leak as printing it.
   */
  label?: string
}

export function QrCode({ payload, size = DEFAULT_SIZE, label }: QrCodeProps): React.JSX.Element {
  const { t } = useTranslation()
  const geometry = useMemo(() => {
    try {
      return buildQrGeometry(payload)
    } catch {
      // The encoder refuses a payload past the largest symbol. Unreachable for a
      // server address and a token, but a caught failure that renders a sentence
      // beats an unhandled one that blanks the dialog the token is standing in.
      return null
    }
  }, [payload])

  if (geometry === null) {
    return (
      <p role="status">{t("The code couldn't be generated. Copy the address and the token by hand.")}</p>
    )
  }

  return (
    <div style={qrFrame}>
      <svg
        role="img"
        aria-label={label ?? t("QR code to pair the phone")}
        width={size}
        height={size}
        viewBox={`0 0 ${geometry.extent} ${geometry.extent}`}
        shapeRendering="crispEdges"
      >
        <rect width={geometry.extent} height={geometry.extent} fill="#ffffff" />
        <path d={geometry.path} fill="#000000" />
      </svg>
    </div>
  )
}
