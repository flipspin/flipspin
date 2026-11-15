/**
 * The card "Send to → VLC" opens over the selection bar: "Address", then
 * "Enviar N canciones"; after a failure the same card says where nothing
 * answered and offers "Retry". Mounted once by the shell, which hands in
 * how the working address is stored (`SettingsContext`'s VLC address).
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import '../ui/tokens/base.css'
import '../ui/tokens/personal.css'
import '../ui/primitives.css'
import '../settings/settings.css'

import { closeVlcCard, registerVlcAddressStore, sendToVlc, setCardAddress, useVlcState } from './vlcSend'

export interface VlcSendCardProps {
  setVlcIp: (ip: string) => void
  /** light · dark · night, from the app's mode. */
  mode?: string
}

export function VlcSendCard({ setVlcIp, mode = 'light' }: VlcSendCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const { card, done } = useVlcState()
  const [toast, setToast] = useState<{ text: string; err: boolean } | null>(null)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => registerVlcAddressStore(setVlcIp), [setVlcIp])

  useEffect(() => {
    if (!done) return
    setToast(
      done.failed > 0
        ? { text: t("{{sent}} sent, {{failed}} failed.", { sent: done.sent, failed: done.failed }), err: true }
        : { text: t("{{n}} songs sent to VLC.", { count: done.sent, n: done.sent }), err: false },
    )
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [done, t])

  useEffect(() => {
    if (card.kind === 'ask') field.current?.focus()
  }, [card.kind])

  const dark = mode === 'dark' || mode === 'night'
  return (
    <div className="krobi-settings z-root vs-scope" data-profile="krobi" data-theme={dark ? 'dark' : 'light'}>
      {card.kind === 'ask' ? (
        <form
          className="vs-pop"
          role="dialog"
          aria-label={t('VLC')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeVlcCard()
          }}
          onSubmit={(event) => {
            event.preventDefault()
            if (card.address.trim() !== '' && !card.sending) void sendToVlc(card.songs, card.address)
          }}
        >
          <b className="vs-pop__title">{t('VLC')}</b>
          <div className="z-field">
            <label className="z-label" htmlFor="vs-address">
              <span className="vs-tip" title={t("A computer with VLC and its web interface on (Preferences → Interface → Web).")}>
                {t("Address")}
              </span>
            </label>
            <input
              ref={field}
              id="vs-address"
              className="z-input z-input--mono"
              placeholder="192.168.1.50"
              value={card.address}
              aria-invalid={card.failedAt !== null}
              onChange={(event) => setCardAddress(event.target.value)}
            />
            {card.failedAt !== null ? (
              <span className="z-err" role="alert">
                {t("No answer at {{ip}}", { ip: card.failedAt })}
              </span>
            ) : null}
          </div>
          <div className="vs-pop__foot">
            <button className="z-btn z-btn--sm z-btn--ghost" type="button" onClick={closeVlcCard}>
              {t("Cancel")}
            </button>
            <button className="z-btn z-btn--sm z-btn--coral" type="submit" disabled={card.address.trim() === '' || card.sending}>
              {card.failedAt !== null && card.failedAt === card.address.trim()
                ? t("Retry")
                : t("Send {{n}} songs", { count: card.songs.length, n: card.songs.length })}
            </button>
          </div>
        </form>
      ) : null}
      {toast ? (
        <div className={`z-toast vs-toast ${toast.err ? 'z-toast--danger' : 'z-toast--success'}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  )
}
