import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { bridge, hasBridge } from '../../bridge'
import './custom-headers.css'

type Row = { name: string; set: boolean; value?: string }
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
function valid(rows: Row[]) {
  const names = rows.map(row => row.name.toLowerCase())
  return new Set(names).size === names.length && rows.every(row => token.test(row.name)
    && !/^(host|authorization|cookie|content-length|connection|transfer-encoding)$/i.test(row.name)
    && !/^x-krobi-/i.test(row.name) && !/[\r\n]/.test(row.value ?? '') && (row.set || row.value !== undefined))
}

export function CustomHeaders({ origin, setup = false }: { origin?: string; setup?: boolean }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(true)
  const [problem, setProblem] = useState(false)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!hasBridge()) return
    let active = true
    void bridge().invoke('headers:get', origin ? { origin } : undefined).then(headers => {
      if (active) { setRows(headers); setBusy(false) }
    }).catch(() => { if (active) { setProblem(true); setBusy(false) } })
    return () => { active = false }
  }, [origin])
  if (!hasBridge()) return null
  const change = (index: number, patch: Partial<Row>) => { setDirty(true); setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row)) }
  async function save() {
    setBusy(true)
    setProblem(false)
    try {
      const saved = await bridge().invoke('headers:set', { ...(origin ? { origin } : {}), headers: rows.map(({ name, value }) => ({ name, ...(value === undefined ? {} : { value }) })) })
      setRows(saved)
      setDirty(false)
    } catch { setProblem(true) }
    finally { setBusy(false) }
  }
  const add = () => { setDirty(true); setRows(current => [...current, { name: '', set: false }]) }
  if (!setup) return <section className="settings-block ks-group custom-headers" aria-label={t("Custom headers")}>
    <form onSubmit={event => { event.preventDefault(); if (valid(rows)) void save() }}>
      <div className="ks-row">
        <div className="ks-l"><b title={t("Reverse proxy authentication")}>{t("Custom headers")}</b></div>
        <div className="ks-c"><button className="ks-btn" type="button" disabled={busy} onClick={add}>{t("Add header")}</button></div>
      </div>
      {rows.map((row, index) => <div className="custom-headers__row" key={index}>
        <label className="custom-headers__field"><span className="z-label">{t("Header name")}</span><input className="ks-field" value={row.name} disabled={busy} onChange={event => change(index, { name: event.target.value, set: false })} autoComplete="off" spellCheck={false} /></label>
        <label className="custom-headers__field"><span className="z-label">{t("Header value")}</span><input className="ks-field" type="password" value={row.value ?? ''} placeholder={row.set ? '••••••••' : ''} aria-label={row.set ? t("Saved header value") : t("Header value")} disabled={busy} autoComplete="new-password" onChange={event => change(index, { value: event.target.value })} /></label>
        <button className="ks-btn" type="button" disabled={busy} onClick={() => { setDirty(true); setRows(current => current.filter((_, i) => i !== index)) }}>{t("Delete")}</button>
      </div>)}
      {problem ? <span className="z-err" role="alert">{t("Could not save headers")}</span> : null}
      {rows.length > 0 || dirty ? <div className="custom-headers__actions"><button className="ks-btn ks-btn--go" type="submit" disabled={busy || !valid(rows)}>{t("Save headers")}</button></div> : null}
    </form>
  </section>
  return <section className="kob-field">
    <h2 className="kob-label" title={t("Reverse proxy authentication")}>{t("Custom headers")}</h2>
    <form className="kob-field" onSubmit={event => { event.preventDefault(); if (valid(rows)) void save() }}>
      {rows.map((row, index) => <div className="custom-headers__row" key={index}>
        <label className="custom-headers__field"><span className={setup ? "kob-label" : "z-label"}>{t("Header name")}</span><input className={setup ? "kob-input" : "ks-field"} value={row.name} disabled={busy} onChange={event => change(index, { name: event.target.value, set: false })} autoComplete="off" spellCheck={false} /></label>
        <label className="custom-headers__field"><span className={setup ? "kob-label" : "z-label"}>{t("Header value")}</span><input className={setup ? "kob-input" : "ks-field"} type="password" value={row.value ?? ''} placeholder={row.set ? '••••••••' : ''} aria-label={row.set ? t("Saved header value") : t("Header value")} disabled={busy} autoComplete="new-password" onChange={event => change(index, { value: event.target.value })} /></label>
        <button className={setup ? "kob-btn" : "ks-btn"} type="button" disabled={busy} onClick={() => setRows(current => current.filter((_, i) => i !== index))}>{t("Delete")}</button>
      </div>)}
      {problem ? <span className="z-err" role="alert">{t("Could not save headers")}</span> : null}
      <div className="custom-headers__actions">
        <button className={setup ? "kob-btn" : "ks-btn"} type="button" disabled={busy} onClick={() => setRows(current => [...current, { name: '', set: false }])}>{t("Add header")}</button>
        <button className={setup ? "kob-btn" : "ks-btn ks-btn--go"} type="submit" disabled={busy || !valid(rows)}>{t("Save headers")}</button>
      </div>
    </form>
  </section>
}
