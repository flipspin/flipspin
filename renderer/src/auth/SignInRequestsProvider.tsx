import { poll as pollInterval } from '../data/poll'
import { watchChanges } from '../data/changeListeners'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { apiGet, isApiError, type CurrentUser } from '../data'
import { normalizeSignInCode, validSignInCode } from './signInCode'
import { SignInRequestsContext, type SignInRequest } from './signInRequests'
import { useSignInTheme } from './signInTheme'
import { SignInRequestSheet } from './SignInRequestSheet'

export function SignInRequestsProvider({ me, children }: { me: CurrentUser | null; children: ReactNode }) {
  const { t } = useTranslation()
  const theme = useSignInTheme()
  const [selection, setSelection] = useState<{ request: SignInRequest; typed: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seen = useRef(new Set<string>())
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const alive = useRef(true)
  const lookup = useRef(0)
  const tokenAccount = me?.source === 'token'

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; lookup.current += 1 }
  }, [])

  const openRequest = useCallback((request: SignInRequest) => {
    if (!tokenAccount) return
    seen.current.add(request.id)
    setSelection({ request, typed: true })
  }, [tokenAccount])

  const openCode = useCallback((code: string) => {
    if (!tokenAccount) return
    const normalized = normalizeSignInCode(code)
    const attempt = ++lookup.current
    setError(null)
    if (!validSignInCode(normalized)) {
      setError(t("Code unavailable. Check that it is correct and has not expired."))
      return
    }
    void apiGet('/api/me/sign-in-code/{code}', { params: { path: { code: normalized } } }).then(request => {
      if (alive.current && lookup.current === attempt) {
        openRequest(request)
      }
    }).catch(cause => {
      if (alive.current && lookup.current === attempt) setError(isApiError(cause) && cause.status === 429
        ? t("Too many attempts. Wait a minute.")
        : t("Code unavailable. Check that it is correct and has not expired."))
    })
  }, [tokenAccount, t, openRequest])

  useEffect(() => {
    if (!tokenAccount) return
    let live = true
    let pending = false
    const poll = async () => {
      if (pollInterval('idle') === false || pending) return
      pending = true
      try {
        const result = await apiGet('/api/me/sign-in-requests')
        if (!live || selectionRef.current) return
        const request = result.requests.find(row => !seen.current.has(row.id))
        if (request) {
          seen.current.add(request.id)
          setSelection({ request, typed: false })
        }
      } catch { /* An older or offline nest must not interrupt the app. */ }
      finally { pending = false }
    }
    const stop = watchChanges(['signin'], poll)
    return () => { live = false; stop() }
  }, [tokenAccount, me?.id])

  return <SignInRequestsContext.Provider value={{ openCode, openRequest }}>
    {children}
    {selection && <SignInRequestSheet key={selection.request.id} request={selection.request} typed={selection.typed}
      account={me?.username ?? me?.label ?? ''} onClose={() => setSelection(null)} onDecided={() => { seen.current.add(selection.request.id) }} />}
    {error && createPortal(<div className="krobi-setup z-root krobi-sign-in ksr-link-error" data-profile="krobi" data-theme={theme} role="alert">{error}<button onClick={() => setError(null)}>{t("Close")}</button></div>, document.body)}
  </SignInRequestsContext.Provider>
}
