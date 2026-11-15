/** The server stores only a token digest, so this reveal cannot be recovered.
 * Require explicit capture confirmation before dismissal. Send the token only to
 * the QR encoder and read-only input; the parent drops it on close. */

import { useId, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { QrCode } from './QrCode'
import { buildAccessLink, isLoopbackServer } from './accessLink'
import { usePairing } from './PairingProvider'
import { ROLE_NAMES } from './messages'
import type { MintedAccess } from './types'

export interface MintedAccessRevealProps {
  access: MintedAccess
  /** Called only from the confirm button. There is no other way out. */
  onDismiss: () => void
}

/** Pass the token directly to the copier and keep feedback free of its value. */
function CopyButton({ value, children }: { value: string; children: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { copyText } = usePairing()
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null)

  return (
    <>
      <button
        type="button"
        className="mk-btn mk-btn--paper-2"
        onClick={() => {
          void copyText(value).then((ok) => setFeedback(ok ? 'copied' : 'failed'))
        }}
      >
        {children}
      </button>
      {feedback === null ? null : (
        <span role="status" className="mk-muted">
          {feedback === 'copied' ? t("Copied to the clipboard.") : t("Couldn't copy. Select it by hand.")}
        </span>
      )}
    </>
  )
}

export function MintedAccessReveal({
  access,
  onDismiss,
}: MintedAccessRevealProps): React.JSX.Element {
  const { t } = useTranslation()
  const { serverUrl } = usePairing()
  const [captured, setCaptured] = useState(false)
  const headingId = useId()
  const serverId = useId()
  const tokenId = useId()
  const confirmId = useId()

  // Show manual fields when the phone cannot use the configured address; do not draw an unusable QR code.
  const link = buildAccessLink(serverUrl, access.token)
  // A loopback address is not worth copying either: on the phone it names the phone.
  const onlyThisComputer = isLoopbackServer(serverUrl)

  return (
    <section role="dialog" aria-labelledby={headingId} aria-modal="true" className="mk-card mk-reveal">
      <div className="mk-card__head">
        <h3 id={headingId} className="mk-card__title">
          {t("Save this access now")}
        </h3>
      </div>

      <p className="mk-body">
        <Trans i18nKey={"This token is shown <strong>only once</strong>. Your nest only keeps a digest of it, so it cannot be viewed again: if you close this without saving it, you will need to remove access for “{{label}}” and create a new one."} t={t}>
          Este token se muestra <strong>una sola vez</strong>. Tu nido solo guarda un resumen
          suyo, así que no se puede volver a ver: si cierras esto sin apuntarlo, habrá que quitar el acceso a
          «{{ label: access.device.label }}» y crear un acceso nuevo.
        </Trans>
      </p>

      <div className="mk-stack">
        {link === null ? (
          <p role="alert" className="mk-confirm__warn">
            {onlyThisComputer
              ? t("To pair a phone, this computer needs to be on your network.")
              : t(
                  "Could not create the QR code because the nest’s address is not valid. Copy the token and enter it on the phone.",
                )}
          </p>
        ) : (
          <>
            <QrCode payload={link} />
            <p className="mk-body">{t("Open your phone's camera and point it at the code.")}</p>
          </>
        )}

        {onlyThisComputer ? null : (
          <>
            <p className="mk-muted">
              {t("If the phone can't scan, copy these two values into the app's settings.")}
            </p>

            <div className="mk-stack--tight">
              <label htmlFor={serverId} className="mk-label">
                {t("Nest address")}
              </label>
              <input id={serverId} readOnly value={serverUrl} className="mk-field mk-field--mono mk-field--secret" />
              <div className="mk-row">
                <CopyButton value={serverUrl}>{t("Copy address")}</CopyButton>
              </div>
            </div>
          </>
        )}

        <div className="mk-stack--tight">
          <label htmlFor={tokenId} className="mk-label">
            {t("Access token")}
          </label>
          <input id={tokenId} readOnly value={access.token} className="mk-field mk-field--mono mk-field--secret" />
          <div className="mk-row">
            <CopyButton value={access.token}>{t("Copy token")}</CopyButton>
          </div>
        </div>
      </div>

      <p className="mk-muted">{t("Type: {{role}}.", { role: t(ROLE_NAMES[access.device.role]) })}</p>

      <div className="mk-stack">
        <div className="mk-row">
          <input
            id={confirmId}
            type="checkbox"
            checked={captured}
            onChange={(event) => setCaptured(event.target.checked)}
          />
          <label htmlFor={confirmId} className="mk-label">
            {t("I've scanned the code or saved the token")}
          </label>
        </div>
        <div>
          <button type="button" className="mk-btn" disabled={!captured} onClick={onDismiss}>
            {t("Done")}
          </button>
        </div>
      </div>
    </section>
  )
}
