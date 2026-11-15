/** Once minted, keep the reveal mounted until capture is confirmed; the server cannot show the token again. */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MintedAccessReveal } from './MintedAccessReveal'
import { usePairing } from './PairingProvider'
import { DEFAULT_ROLE, ROLE_EXPLANATIONS, ROLE_NAMES, mintFailureText } from './messages'
import { isPairingError } from './types'
import type { MintedAccess, PairedDevice, PairingFailureKind, Role } from './types'
import { dialog, muted, row, stack } from './styles'

const ROLE_ORDER: readonly Role[] = ['member', 'owner']

export interface PairDeviceFlowProps {
  /** The reveal was dismissed. The new row is handed over so a list can grow. */
  onFinished: (device: PairedDevice) => void
  /** Available before minting and never after. */
  onCancel: () => void
}

export function PairDeviceFlow({ onFinished, onCancel }: PairDeviceFlowProps): React.JSX.Element {
  const { t } = useTranslation()
  const { gateway } = usePairing()
  const [label, setLabel] = useState('')
  const [role, setRole] = useState<Role>(DEFAULT_ROLE)
  const [pending, setPending] = useState(false)
  // The failure *kind*, not its sentence: worded at render so it follows the language.
  const [problem, setProblem] = useState<PairingFailureKind | null>(null)
  // Drop the plaintext token on dismissal and keep it out of persistent state.
  const [minted, setMinted] = useState<MintedAccess | null>(null)

  const headingId = useId()
  const labelId = useId()
  const roleGroupId = useId()

  if (minted !== null) {
    return (
      <MintedAccessReveal
        access={minted}
        onDismiss={() => {
          const { device } = minted
          setMinted(null)
          onFinished(device)
        }}
      />
    )
  }

  const trimmed = label.trim()

  async function mint(): Promise<void> {
    setPending(true)
    setProblem(null)
    try {
      setMinted(await gateway.mintDevice({ label: trimmed, role }))
    } catch (cause) {
      setProblem(isPairingError(cause) ? cause.kind : 'unreachable')
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      aria-labelledby={headingId}
      style={dialog}
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed === '' || pending) return
        void mint()
      }}
    >
      <h3 id={headingId}>{t("Add a device")}</h3>

      <div style={stack}>
        <label htmlFor={labelId}>{t("Device name")}</label>
        <input
          id={labelId}
          value={label}
          maxLength={80}
          placeholder={t("Robin's iPhone")}
          onChange={(event) => setLabel(event.target.value)}
        />
        <span style={muted}>
          {t("It's only there to recognise it in this list and be able to revoke its access later.")}
        </span>
      </div>

      <fieldset aria-describedby={roleGroupId} style={stack}>
        <legend>{t("What this device can do")}</legend>
        <span id={roleGroupId} style={muted}>
          {t(
            "Chosen now and can't be changed later: to change it you have to revoke the access and create another.",
          )}
        </span>
        {ROLE_ORDER.map((option) => (
          <label key={option} style={row}>
            <input
              type="radio"
              name="pairing-role"
              value={option}
              checked={role === option}
              onChange={() => setRole(option)}
            />
            <span>
              <strong>{t(ROLE_NAMES[option])}</strong> — {t(ROLE_EXPLANATIONS[option])}
            </span>
          </label>
        ))}
      </fieldset>

      {problem === null ? null : <p role="alert">{mintFailureText(problem)}</p>}

      <div style={row}>
        <button type="submit" disabled={trimmed === '' || pending}>
          {pending ? t("Creating…") : t("Create access")}
        </button>
        <button type="button" onClick={onCancel} disabled={pending}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  )
}
