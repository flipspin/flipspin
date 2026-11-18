/** Name the device and sign-out consequence before revocation because it takes effect immediately.
 * Keep empty and forbidden states distinct so a refused read cannot imply that nobody has access. */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ROLE_NAMES, formatMoment, revokeFailureText } from './messages'
import { isPairingError } from './types'
import type { PairedDevice, PairingFailureKind } from './types'
import { cell, headerCell, muted, row, stack, table } from './styles'
import { missingWord } from '../ui/react/components/missingWords'

export interface DeviceListProps {
  devices: readonly PairedDevice[]
  /** Rejects with a `PairingError`; the row renders the reason itself. */
  onRevoke: (device: PairedDevice) => Promise<void>
}

export function DeviceList({ devices, onRevoke }: DeviceListProps): React.JSX.Element {
  const { t } = useTranslation()
  // Ids rather than objects: the list is refetched around a revoke and an object
  // identity from the previous fetch would silently stop matching.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  // The failure *kind*, not its sentence: worded at render so it follows the language.
  const [problem, setProblem] = useState<{ id: string; kind: PairingFailureKind } | null>(null)

  if (devices.length === 0) {
    return <p>{t("No device has been paired yet.")}</p>
  }

  async function revoke(device: PairedDevice): Promise<void> {
    setWorking(device.id)
    setProblem(null)
    try {
      await onRevoke(device)
      setConfirming(null)
    } catch (cause) {
      setProblem({
        id: device.id,
        kind: isPairingError(cause) ? cause.kind : 'unreachable',
      })
    } finally {
      setWorking(null)
    }
  }

  return (
    <table style={table}>
      <caption style={muted}>{t("Devices with access to this nest")}</caption>
      <thead>
        <tr>
          <th scope="col" style={headerCell}>
            {t("Device")}
          </th>
          <th scope="col" style={headerCell}>
            {t("Type")}
          </th>
          <th scope="col" style={headerCell}>
            {t("Created")}
          </th>
          <th scope="col" style={headerCell}>
            {t("Last seen")}
          </th>
          <th scope="col" style={headerCell}>
            <span>{t("Actions")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {devices.map((device) => (
          <tr key={device.id}>
            <th scope="row" style={cell}>
              {device.label}
            </th>
            <td style={cell}>{t(ROLE_NAMES[device.role])}</td>
            <td style={cell}>{formatMoment(device.createdAt, missingWord('nodata'))}</td>
            <td style={cell}>{formatMoment(device.lastSeenAt)}</td>
            <td style={cell}>
              {confirming === device.id ? (
                <div style={stack}>
                  <span role="alert">
                    {t(
                      "Remove access for “{{label}}”? That device will stop working immediately.",
                      { label: device.label },
                    )}
                  </span>
                  <div style={row}>
                    <button
                      type="button"
                      disabled={working === device.id}
                      onClick={() => void revoke(device)}
                    >
                      {working === device.id ? t("Removing access…") : t("Remove access")}
                    </button>
                    <button
                      type="button"
                      disabled={working === device.id}
                      onClick={() => {
                        setConfirming(null)
                        setProblem(null)
                      }}
                    >
                      {t("Cancel")}
                    </button>
                  </div>
                  {problem?.id === device.id ? (
                    <span role="alert">{revokeFailureText(problem.kind)}</span>
                  ) : null}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(device.id)
                    setProblem(null)
                  }}
                >
                  {t("Remove access for “{{label}}”", { label: device.label })}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
