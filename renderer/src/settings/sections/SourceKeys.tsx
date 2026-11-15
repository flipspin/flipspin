import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '../../data'
import { useChangeSecrets, useSecrets, type SecretStatus } from '../../data/hooks/use-secrets'
import { Missing } from '../../ui/react/components/Missing'
import { QueryFailure, Skel, Word } from '../parts'
import { formatSeen } from '../format'
import { takeLanding } from '../landing'

function secretState(rows: SecretStatus[]): SecretStatus['state'] | null {
  return rows.length === 0 ? null : rows.some(r => r.state === 'ilegible') ? 'ilegible'
    : rows.some(r => r.state === 'rechazada') ? 'rechazada'
      : rows.some(r => r.state === 'falta') ? 'falta' : 'guardada'
}

function KeyRow({ label, names, rows }: { label: string; names: string[]; rows: SecretStatus[] }) {
  const { t } = useTranslation()
  const change = useChangeSecrets()
  const [editing, setEditing] = useState(() => label === 'Spotify' && takeLanding('spotify-keys'))
  const [values, setValues] = useState<string[]>(names.map(() => ''))
  const [problem, setProblem] = useState<string | null>(null)
  const [result, setResult] = useState<'verified' | 'pending' | 'rejected' | null>(null)
  const state = secretState(rows)
  const locked = rows.some(r => r.locked)
  const complete = names.every(name => rows.some(r => r.name === name))
  const reason = rows.find(r => r.reason)?.reason
  const words = { guardada: t("Saved_feminine"), falta: t("Missing"), rechazada: t("Rejected_single"), ilegible: t("Unreadable") }
  const location = rows.some(r => r.source === 'env') ? t("set by the environment")
    : rows.some(r => r.source === 'file') ? t("set by a file") : t("encrypted in the nest")
  const verified = rows.map(r => r.verifiedAt).filter((date): date is string => !!date)
  const tip = [reason, verified.length ? t("Verified {{date}}", { date: formatSeen(verified.sort()[0]) }) : t("Not checked")].filter(Boolean).join(' · ')

  async function save(remove: boolean) {
    setProblem(null)
    setResult(null)
    try {
      const next = await change.mutateAsync({ names, values: remove ? null : values.map(v => v.trim()) })
      setValues(names.map(() => ''))
      if (remove) setEditing(false)
      else {
        const updated = next.secrets.filter(r => names.includes(r.name))
        setResult(updated.some(r => r.state === 'rechazada') ? 'rejected' : updated.length === names.length && updated.every(r => r.verifiedAt) ? 'verified' : 'pending')
      }
    } catch (error) {
      setProblem(isApiError(error) && error.status === 409 ? t("The key is locked") : t("Could not save the key_accessKey"))
    } finally {
      change.reset()
    }
  }

  return <div className="settings-source" data-source-key={label}>
    <div className="ks-row">
      <div className="ks-l"><b>{label}</b>
        {complete && state ? <Word tone={state === 'guardada' ? 'ok' : state === 'falta' ? 'warn' : 'bad'} title={tip}>{words[state]}</Word> : <Missing kind="nodata" />}
        {locked || rows.some(r => r.state !== 'falta') ? <span className="z-mono" title={locked ? names.join(' · ') : tip}>{location}</span> : null}
      </div>
      <div className="ks-c">
        {locked ? <span className="z-mono" title={t("Set by the nest environment · {{names}}", { names: names.join(' · ') })}>{t("locked")}</span> : complete && state !== 'ilegible' ? <>
          <button className="ks-link" type="button" disabled={change.isPending} onClick={() => { setEditing(true); setProblem(null); setResult(null) }}>{state === 'falta' ? t("Save") : t("Replace")}</button>
          {rows.some(r => r.state !== 'falta') ? <button className="ks-link" type="button" disabled={change.isPending} onClick={() => void save(true)}>{t("Remove")}</button> : null}
        </> : null}
      </div>
    </div>
    {editing && !locked ? <form className="settings-source-form" onSubmit={event => { event.preventDefault(); if (!change.isPending && values.every(v => v.trim())) void save(false) }}>
      {names.map((name, i) => <div className="ks-row" key={name}><label className="ks-l" htmlFor={`secret-${name}`}><b>{names.length === 2 ? (i === 0 ? t("Client ID_translated") : t("Client secret")) : t("Access token")}</b></label><div className="ks-c"><input className="ks-field ks-field--mono" id={`secret-${name}`} type="password" autoComplete="new-password" spellCheck={false} disabled={change.isPending} value={values[i]} onChange={event => { setResult(null); setValues(values.map((v, at) => at === i ? event.target.value : v)) }} /></div></div>)}
      <div className="settings-source-form__actions"><button className="ks-link" type="button" disabled={change.isPending} onClick={() => { setEditing(false); setValues(names.map(() => '')) }}>{result ? t("Done") : t("Cancel")}</button><button className="ks-link" type="submit" disabled={change.isPending || !values.every(v => v.trim())}>{t("Save")}</button>
        {result ? <Word tone={result === 'verified' ? 'ok' : result === 'rejected' ? 'bad' : 'warn'} title={tip}>{result === 'verified' ? t("Verified") : result === 'rejected' ? t("Rejected_single") : t("To do")}</Word> : null}
      </div>
    </form> : null}
    {problem ? <span className="z-err" role="alert">{problem}</span> : null}
  </div>
}

export function SourceKeys() {
  const { t } = useTranslation()
  const query = useSecrets()
  const groups = [
    { label: 'Genius', names: ['KROBI_GENIUS_API_KEY'] },
    { label: 'Spotify', names: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'] },
  ]
  return <section className="settings-block ks-group" aria-label={t("Source keys")}>
    <div className="settings-block__head"><h3 title={t("Stored encrypted in the nest; never displayed")}>{t("Source keys")}</h3></div>
    {query.isPending ? <Skel rows={3} /> : query.isError ? <QueryFailure error={query.error} what={t("keys")} onRetry={() => void query.refetch()} /> : <div className="settings-block__body">
      {groups.map(group => <KeyRow key={group.label} {...group} rows={query.data.secrets.filter(r => group.names.includes(r.name))} />)}
    </div>}
  </section>
}
