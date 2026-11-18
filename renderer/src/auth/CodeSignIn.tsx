import { focusManager } from '@tanstack/react-query'
import { poll as pollInterval, startPoll } from '../data/poll'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiGet, apiPost, isApiError, serverDetail, type ApiData } from '../data'
import { bridge } from '../bridge'
import { codeExpiry, displaySignInCode } from './signInCode'
import '../onboarding/nest.css'

type Ticket = ApiData<'/api/sign-in-code', 'post'> & { deadline: number }

export function CodeSignIn({ username, deviceLabel, onSignedIn }: {
  username: string
  deviceLabel: string
  onSignedIn: () => void
}) {
  const { t } = useTranslation()
  const [requestedUser, setRequestedUser] = useState<string | null>(null)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [remaining, setRemaining] = useState(600)
  const [problem, setProblem] = useState<string | null>(null)
  const [outside, setOutside] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [renewed, setRenewed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [signedInUser, setSignedInUser] = useState<string | null>(null)
  const [credential, setCredential] = useState<string | null>(null)
  const [storageAttempt, setStorageAttempt] = useState(0)
  const signedIn = useRef(onSignedIn)
  signedIn.current = onSignedIn

  useEffect(() => {
    if (requestedUser === null) return
    let alive = true
    setProblem(null)
    setTicket(null)
    setDeclined(false)
    void apiPost('/api/sign-in-code', { body: { deviceLabel, username: requestedUser } }).then(made => {
      if (alive) {
        setRemaining(made.expiresIn)
        setTicket({ ...made, deadline: Date.now() + made.expiresIn * 1000 })
      }
    }).catch(error => {
      if (!alive) return
      if (isApiError(error) && error.status === 403 && serverDetail(error) === 'outside-network') setOutside(true)
      else setProblem(isApiError(error) && error.status === 429
        ? t("Too many codes. Wait a minute.") : t("Could not request a code."))
    })
    return () => { alive = false }
  }, [deviceLabel, requestedUser, retry, t])

  useEffect(() => {
    if (!ticket || credential || declined) return
    let alive = true
    let finished = false
    const countdown = setInterval(() => setRemaining(Math.max(0, (ticket.deadline - Date.now()) / 1000)), 1000)
    const poll = async () => {
      if (!alive || finished || Date.now() >= ticket.deadline) return
      try {
        const result = await apiPost('/api/sign-in-code/poll', { body: { secret: ticket.secret } })
        if (!alive) return
        if (result.declined) {
          finished = true
          setDeclined(true)
          setProblem(null)
          return
        }
        if (result.credential) {
          finished = true
          setCredential(result.credential.token)
          setProblem(null)
          return
        }
        setProblem(null)
      } catch {
        if (alive) setProblem(t("Could not check the code. Retrying…"))
      }
    }
    const stop = startPoll(() => pollInterval('waiting', !finished && Date.now() < ticket.deadline, ticket.pollInterval * 1000, false), poll, false)
    return () => { alive = false; stop(); clearInterval(countdown) }
  }, [ticket, credential, declined, t])

  useEffect(() => {
    if (!ticket || remaining > 0 || credential || declined) return
    let renewed = false
    const renew = () => {
      if (renewed || pollInterval('waiting', true) === false) return
      renewed = true
      setRenewed(true)
      // The display clock keeps running; requesting a new code waits for focus.
      setTicket(null)
      setRetry(n => n + 1)
    }
    renew()
    return focusManager.subscribe(focused => { if (focused) renew() })
  }, [ticket, remaining, credential, declined])

  useEffect(() => {
    if (!credential) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    void bridge().invoke('auth:set', { token: credential, label: deviceLabel }).then(stored => {
      if (!stored?.ok) throw new Error('credential storage failed')
      if (!alive) return
      timer = setTimeout(() => signedIn.current(), 1500)
      // Typed approval may come from a different account or fix an unknown username.
      void apiGet('/api/me', { signal: controller.signal }).then(me => {
        if (alive) setSignedInUser(me.username ?? me.label)
      }).catch(() => { /* Continue into the app if the nest goes offline after redemption. */ })
    }).catch(() => {
      if (alive) setProblem(t("Could not save access. Try again."))
    })
    return () => { alive = false; clearTimeout(timer); controller.abort() }
  }, [credential, storageAttempt, deviceLabel, t])

  return <section className="kob-code-sign-in" aria-labelledby="code-sign-in-title">
    <h2 id="code-sign-in-title">{t("With another device")}</h2>
    {credential ? <div role="status" className="kob-code-sign-in__result"><b>{t("Done")}</b><span>{t("signing in as {{user}}…", { user: signedInUser ?? requestedUser })}</span></div>
      : outside ? <h3>{t("Only from home or the VPN")}</h3>
        : declined ? <><h3>{t("Declined")}</h3><button type="button" className="kob-btn" onClick={() => setRetry(n => n + 1)}>{t("Request another code")}</button></>
          : requestedUser === null ? <button type="button" className="kob-btn" disabled={!username.trim()} onClick={() => setRequestedUser(username.trim())}>{t("Continue")}</button>
            : ticket ? <>
              {renewed && <div role="status"><b>{t("New code")}</b> · {t("the previous one expired")}</div>}
              <output className="kob-code-sign-in__code kob-mono" aria-label={t("Code")}>{displaySignInCode(ticket.code)}</output>
              <span className="kob-mono kob-muted" title={t("Each code lasts 10 minutes; then a new one appears")}>{t("expires in {{time}}", { time: codeExpiry(remaining) })}</span>
            </> : !problem && <span role="status">{t("Requesting code…")}</span>}
    {!credential && <span>{t("Approve it in Flipspin on a computer that is signed in.")}</span>}
    {ticket && !credential && !declined && <span className="kob-status kob-code-sign-in__waiting" role="status"><i className="kob-dot is-wait" />{t("Waiting for approval…")}</span>}
    {problem && <p role="alert">{problem}</p>}
    {problem && !outside && <button type="button" className="kob-btn" onClick={() => credential ? setStorageAttempt(n => n + 1) : setRetry(n => n + 1)}>{t("Retry")}</button>}
    {!credential && requestedUser !== null && <button type="button" className="kob-btn kob-btn--ghost kob-code-sign-in__back" onClick={() => { setRequestedUser(null); setTicket(null); setProblem(null); setOutside(false); setDeclined(false); setRenewed(false) }}>{t("Sign in with a password")}</button>}
  </section>
}
