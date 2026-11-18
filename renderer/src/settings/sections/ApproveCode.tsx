import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSignInRequests } from '../../auth/signInRequests'
import { CODE_ALPHABET, CODE_LENGTH, normalizeSignInCode, validSignInCode } from '../../auth/signInCode'
import { apiGet, isApiError } from '../../data'
import { Modal } from '../parts'

const emptyCode = () => Array<string>(CODE_LENGTH).fill('')

export function ApproveCode({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { openRequest } = useSignInRequests()
  const [characters, setCharacters] = useState(emptyCode)
  const [problem, setProblem] = useState<string | null>(null)
  const [shaking, setShaking] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const pending = useRef<AbortController | null>(null)
  const errorId = useId()

  useEffect(() => () => pending.current?.abort(), [])

  async function inspect(code: string) {
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    try {
      const request = await apiGet('/api/me/sign-in-code/{code}', {
        params: { path: { code } }, signal: controller.signal,
      })
      if (controller.signal.aborted) return
      onClose()
      openRequest(request)
    } catch (error) {
      if (controller.signal.aborted) return
      const status = isApiError(error) ? error.status : null
      setCharacters(emptyCode())
      setShaking(true)
      setProblem(status === 404 || status === 410 ? t("Invalid code")
        : status === 429 ? t("Too many attempts. Wait a minute.")
        : t("Code unavailable. Check that it is correct and has not expired._review"))
      inputs.current[0]?.focus()
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null
        setBusy(false)
      }
    }
  }

  function fill(next: string[], focus: number) {
    if (pending.current) return
    setProblem(null)
    setShaking(false)
    setCharacters(next)
    inputs.current[focus]?.focus()
    if (next.every(character => character !== '')) void inspect(next.join(''))
  }

  return <Modal title={t("Code from the other device")} onClose={onClose} className="settings-modal--approve-code">
    <div className={`settings-code-boxes${shaking ? ' is-shaking' : ''}`} role="group" aria-label={t("Code from the other device")}
      aria-busy={busy} aria-describedby={problem ? errorId : undefined} onAnimationEnd={() => setShaking(false)}>
      {characters.map((character, index) => <Fragment key={index}>
        {index === 3 && <span className="settings-code-dot" aria-hidden="true">·</span>}
        <input ref={element => { inputs.current[index] = element }} className="ks-field settings-code-box" type="text"
          aria-label={t("character {{n}} of 6", { n: index + 1 })} aria-invalid={problem !== null}
          value={character} maxLength={1} autoCapitalize="characters" autoComplete="off" spellCheck={false} readOnly={busy}
          onFocus={event => event.currentTarget.select()}
          onChange={event => {
            const raw = event.target.value
            const value = normalizeSignInCode(raw)
            if (raw !== '' && (value.length !== 1 || !CODE_ALPHABET.includes(value))) return
            const next = [...characters]
            next[index] = value
            fill(next, value === '' ? index : Math.min(index + 1, CODE_LENGTH - 1))
          }}
          onPaste={event => {
            event.preventDefault()
            const code = normalizeSignInCode(event.clipboardData.getData('text'))
            if (validSignInCode(code)) fill([...code], CODE_LENGTH - 1)
          }}
          onKeyDown={event => {
            if (busy) return
            if (event.key === 'Backspace') {
              event.preventDefault()
              const next = [...characters]
              next[character === '' ? Math.max(0, index - 1) : index] = ''
              fill(next, Math.max(0, index - 1))
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              inputs.current[Math.max(0, Math.min(CODE_LENGTH - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))]?.focus()
            }
          }} />
      </Fragment>)}
    </div>
    {problem && <span id={errorId} className="z-err" role="alert">{problem}</span>}
    <button className="ks-btn ks-btn--sm ks-btn--icon ks-btn--ghost settings-code-close" type="button" aria-label={t("Close")} onClick={onClose}>
      <X className="i" aria-hidden="true" />
    </button>
  </Modal>
}
