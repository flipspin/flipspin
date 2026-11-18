/** Keep pairing gateway access at this mounting point. A refused device listing
 * is an access error, not an empty list; minting is unavailable in that state. */

import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { DeviceList } from './DeviceList'
import { PairDeviceFlow } from './PairDeviceFlow'
import { usePairing } from './PairingProvider'
import { listFailureText } from './messages'
import { isPairingError } from './types'
import type { PairedDevice, PairingFailureKind } from './types'
import { muted, notice, panel, row } from './styles'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; devices: PairedDevice[] }
  | { status: 'failed'; kind: PairingFailureKind }

export function PairingPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { gateway, serverUrl } = usePairing()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    gateway.listDevices(controller.signal).then(
      (devices) => {
        // Every write in here is guarded. An abort fires when the panel
        // unmounts mid-request, and a `setState` after that is a warning in
        // development and a leak in principle.
        if (!controller.signal.aborted) setState({ status: 'ready', devices })
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'failed', kind: isPairingError(cause) ? cause.kind : 'unreachable' })
      },
    )
    return () => controller.abort()
  }, [gateway, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  const revoke = useCallback(
    async (device: PairedDevice) => {
      await gateway.revokeDevice(device.id)
      // Remove the acknowledged row locally to avoid another loading state after revocation.
      setState((current) =>
        current.status === 'ready'
          ? { status: 'ready', devices: current.devices.filter((d) => d.id !== device.id) }
          : current,
      )
    },
    [gateway],
  )

  return (
    <section style={panel}>
      <h2>{t("Devices")}</h2>
      <p style={muted}>
        <Trans i18nKey={"Link a phone by scanning a code: there is no need to type the address or token. Devices connect to <1>{{url}}</1>."} t={t} values={{ url: serverUrl }}>
          Vincula un teléfono escaneando un código: no hay que escribir ni la dirección ni el
          token. Los dispositivos se conectan a <code>{'{{url}}'}</code>.
        </Trans>
      </p>

      {state.status === 'loading' ? <p role="status">{t("Loading devices…")}</p> : null}

      {state.status === 'failed' ? (
        <div style={notice}>
          <p role="alert">{listFailureText(state.kind)}</p>
          {state.kind === 'forbidden' ? null : (
            <button type="button" onClick={reload}>
              {t("Retry")}
            </button>
          )}
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <>
          <DeviceList devices={state.devices} onRevoke={revoke} />
          {adding ? (
            <PairDeviceFlow
              onCancel={() => setAdding(false)}
              onFinished={(device) => {
                setAdding(false)
                setState((current) =>
                  current.status === 'ready'
                    ? { status: 'ready', devices: [...current.devices, device] }
                    : current,
                )
              }}
            />
          ) : (
            <div style={row}>
              <button type="button" onClick={() => setAdding(true)}>
                {t("Add a device")}
              </button>
              <button type="button" onClick={reload}>
                {t("Refresh")}
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}
