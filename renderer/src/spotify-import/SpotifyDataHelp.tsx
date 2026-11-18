import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover } from '../ui/react/components/Popover'
import { openExternal } from '../ui/components/cardArt'
import './spotify-import.css'

const PRIVACY_URL = 'https://www.spotify.com/account/privacy/'

/** One click to Spotify's data page; the steps sit in the tooltip. */
export function SpotifyDataLink({ className }: { className?: string }) {
  const { t } = useTranslation()
  const steps = [t("Under Download your data, tick Account data and request it"), t("Confirm the email Spotify sends you"),
    t("When the file arrives (Spotify says it can take a few days), drop the .zip here")]
  return <button type="button" className={className} title={steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}
    onClick={() => openExternal(PRIVACY_URL)}>{t("Get it from Spotify")}</button>
}

export function SpotifyDataHelp({ className }: { className?: string }) {
  const { t } = useTranslation()
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" ref={anchor} className={className ?? 'spotify-data-help__trigger'} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>{t("How to get it")}</button>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} className="spotify-data-help" aria-label={t("How to get it")}>
      <ol>
        <li><a href={PRIVACY_URL} onClick={event => { event.preventDefault(); openExternal(PRIVACY_URL) }}>{t("Open Spotify’s privacy settings")}</a></li>
        <li>{t("Under Download your data, tick Account data and request it")}</li>
        <li>{t("Confirm the email Spotify sends you")}</li>
        <li>{t("When the file arrives (Spotify says it can take a few days), drop the .zip here")}</li>
      </ol>
    </Popover>
  </>
}
