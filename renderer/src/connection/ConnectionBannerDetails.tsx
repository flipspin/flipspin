import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { useConnectionStatus } from './connection'
import { useForcedOffline } from '../offline/mode'
import { Popover } from '../ui/react/components/Popover'
import { ConnectionDetails } from './ConnectionDetails'
import './connection.css'

export function ConnectionBannerDetails() {
  const { t } = useTranslation()
  const status = useConnectionStatus()
  const forced = useForcedOffline()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const server = status.kind === 'ready' ? status.value : null
  if (!server || server.connection.state !== 'unreachable' || forced) return null
  return <>
    <button ref={anchor} type="button" className="ks-details-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <Info size={15} strokeWidth={2.5} aria-hidden="true" />{t("Details")}
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} aria-label={t("Connection details")}>
      <ConnectionDetails connection={server.connection} nestName={server.name} address={server.via ?? server.baseUrl} mode={server.mode} />
    </Popover>
  </>
}
