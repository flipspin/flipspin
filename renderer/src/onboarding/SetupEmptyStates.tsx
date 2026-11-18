/** Home offers the unfinished actions where the empty library already lives. */
import './followup.css'

import { useTranslation } from 'react-i18next'

import { useServerHandshake } from '../data'
import { useLibrarySummary, useMyDevices } from '../settings/data'
import { networkReach, reachKey, useNestAddresses } from '../remote/useNestAddresses'
import { useLastReach } from '../settings/reachMemo'
import { isPhoneLabel } from '../pairing/deviceKind'
import { LibraryEmptyState } from './LibraryEmptyState'
import { openSettings } from '../shell/ServerBadge'

export function SetupEmptyStates(): React.JSX.Element {
  const { t } = useTranslation()
  const library = useLibrarySummary()
  const devices = useMyDevices(true)
  const { network } = useNestAddresses()
  const handshake = useServerHandshake()
  const reach = useLastReach(reachKey(network, handshake.data?.instanceId ?? '')) ?? networkReach(network).reach
  let skippedRemote = false
  try { skippedRemote = localStorage.getItem(`krobi.setup-remote.${handshake.data?.instanceId ?? globalThis.location.origin}`) === 'local' } catch { /* Network state remains available when storage is inaccessible. */ }
  return <div className="krobi-setup-followup">
    {library.data?.songs === 0 && <LibraryEmptyState />}
    {devices.data && !devices.data.some(d => !d.isCurrent && d.lastSeenAt && isPhoneLabel(d.label)) && <div>
      <button className="krobi-setup-followup-link" type="button" onClick={() => openSettings('dispositivos')}>{t("Pair a phone")} · {t("Devices")}</button>
    </div>}
    {network && reach !== 'ok' && (skippedRemote || (!network.tailscale && !network.externalUrl)) && <div>
      <button className="krobi-setup-followup-link" type="button" onClick={() => openSettings('remoto')}>{t("Remote access")}</button>
    </div>}
  </div>
}
