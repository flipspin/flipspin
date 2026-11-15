/**
 * "Sources" (admin): an ordered list per kind. The number is the order the
 * nest asks in (an off or keyless source drops out of the count), the
 * credential state is a word, and a source that needs keys opens in place
 * to its form. A switch acts at once and offers "undo".
 *
 * `enabled` (a choice made here) and `available` (are its keys there) are
 * different things: a keyless source's switch is inert until it has them.
 */
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp } from 'lucide-react'

import { msg } from '../../i18n'
import { apiGet, apiPut, queryKeys } from '../../data'
import { useProviders, type Provider } from '../data'
import { Dot, ErrorAlt, QueryFailure, Empty, OldNest, Skel, Switch, Tipped, Word, useToast } from '../parts'
import { isOlderNest } from '../data'
import { Page } from './Head'
import { SourceKeys } from './SourceKeys'
import { useSettings } from '../context'
import type { SectionId } from '../sections'
import { sourceFact, sourceState, sourceTooltip } from '../sourceHealth'
import { RetrySource, SourceStatus, SourceAction } from './SourceHealth'
import { Missing } from '../../ui/react/components/Missing'

const KINDS: { id: string; label: string; tip: string }[] = [
  { id: 'streaming', label: msg('Audio'), tip: msg("Where audio is downloaded from, in this order.") },
  { id: 'metadata', label: msg("Metadata"), tip: msg("Song and album data. Asked in this order, stopping at the first sure answer.") },
  { id: 'lyrics', label: msg("Lyrics_plural"), tip: msg("All are asked; you pick the lyric when you open it. Order only breaks ties.") },
  { id: 'dashboard', label: msg("New releases"), tip: msg("What Browse shows when opened.") },
]

const CAPABILITY: Record<string, string> = {
  isrc: 'ISRC',
  mbid: 'MBID',
  lyrics: msg("lyrics"),
  artwork: msg("artwork"),
  stream: msg("downloads"),
  charts: msg("playlists and releases"),
}

const BROWSERS = ['chrome', 'safari', 'firefox', 'brave', 'edge', 'chromium', 'opera', 'vivaldi']

function CookiesForm({ name }: { name: string }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [browser, setBrowser] = useState('')
  const [file, setFile] = useState('')
  const [busy, setBusy] = useState(false)

  const config = useQuery({ queryKey: [...queryKeys.server.providers(), 'cookies'], queryFn: ({ signal }) => apiGet('/api/config/ytdlp-cookies', { signal }) })
  useEffect(() => {
    const body = config.data
    if (typeof body !== 'object' || body === null) return
    const record = body as { cookies_from_browser?: unknown; cookies_file?: unknown }
    setBrowser(typeof record.cookies_from_browser === 'string' ? record.cookies_from_browser : '')
    setFile(typeof record.cookies_file === 'string' ? record.cookies_file : '')
  }, [config.data])

  const save = async () => {
    setBusy(true)
    try {
      const next = await apiPut('/api/config/ytdlp-cookies', { body: { cookies_from_browser: browser, cookies_file: file } })
      queryClient.setQueryData([...queryKeys.server.providers(), 'cookies'], next)
      toast(t("Cookies saved"))
    } catch {
      toast(t("Could not save the cookies"), { err: true })
    } finally {
      setBusy(false)
    }
  }

  if (config.isPending) return <Skel rows={1} />
  if (config.isError) return <QueryFailure error={config.error} what={t("the cookies")} onRetry={() => void config.refetch()} />

  return (
    <form
      className="settings-source-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy) void save()
      }}
    >
      <div className="ks-row"><label className="ks-l">
        <b>
          <Tipped tip={t("Cookies for {{name}}", { name })}>{t("Browser")}</Tipped>
        </b></label><div className="ks-c">
        <select aria-label={t("Browser")} className="ks-sel" value={browser} onChange={(e) => setBrowser(e.target.value)}>
          <option value="">{t("None")}</option>
          {BROWSERS.map((name) => (
            <option key={name} value={name}>
              {name[0].toUpperCase() + name.slice(1)}
            </option>
          ))}
        </select>
      </div></div>
      <div className="ks-row"><label className="ks-l">
        <b>{t('cookies.txt')}</b></label><div className="ks-c">
        <input aria-label={t('cookies.txt')} className="ks-field ks-field--mono" placeholder={t("/path/to/cookies.txt")} value={file} onChange={(e) => setFile(e.target.value)} />
      </div></div>
      <div className="settings-source-form__actions"><button className="ks-link" type="submit" disabled={busy}>
        {t("Save")}
      </button></div>
    </form>
  )
}

function Credentials({ provider }: { provider: Provider }): React.JSX.Element | null {
  const { host } = useSettings()
  if (provider.id === 'spotify') {
    const Connection = host.SpotifyKeys
    return Connection ? <Connection /> : null
  }
  return <>
    {provider.status?.facts?.map((fact, index) => <div className="ks-row" key={index}><div className="ks-l"><b title={fact.tip ?? undefined}>{fact.label}</b></div><div className="ks-c"><code>{fact.value ?? <Missing kind="nodata" />}</code></div></div>)}
    {provider.status?.actions?.map(action => <div className="ks-row" key={action.id}><div className="ks-c"><SourceAction provider={provider} action={action} /></div></div>)}
    {provider.status?.toggles?.map(toggle => <div className="ks-row" key={toggle.id}><div className="ks-l"><b>{toggle.label}</b></div><div className="ks-c"><SourceAction provider={provider} action={toggle} value={toggle.value} /></div></div>)}
    {provider.status?.warning ? <p className="settings-source__state">{provider.status.warning}</p> : null}
    <CookiesForm name={provider.name} />
  </>
}

function Row({
  provider,
  rank,
  first,
  last,
  busy,
  onToggle,
  onMove,
  problem,
}: {
  provider: Provider
  rank: number | null
  first: boolean
  last: boolean
  busy: boolean
  onToggle: (next: boolean) => void
  onMove: (delta: -1 | 1) => void
  problem: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const audio = provider.kind === 'streaming'
  const state = sourceState(provider)
  const cap = provider.capabilities.map((c) => CAPABILITY[c]).find(Boolean)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const foldId = useId()
  const { host } = useSettings()
  const keyed = audio || (provider.id === 'spotify' && Boolean(host.SpotifyKeys))
  return <div className={`settings-source${keyed ? ' settings-src--fold' : ''}`}>
    <div className="ks-row ks-src-row">
      <code className="ks-rank">{rank ?? ''}</code>
      <div className="ks-l" title={audio ? sourceTooltip(provider, t) : undefined}><b title={provider.id === 'genius' ? t("Gets lyrics from genius.com") : cap ? t(cap) : undefined}>{provider.name}</b>{audio && provider.enabled ? <span>{sourceFact(provider, t)}</span> : null}</div>
      <div className="ks-c">
        {audio && provider.enabled ? <SourceStatus provider={provider} /> : null}
        {audio && provider.enabled && (state === 'busy' || state === 'broken') ? <RetrySource provider={provider} /> : null}
        <span className="ks-ord">
          <button type="button" aria-label={t("Move {{name}} up", { name: provider.name })} disabled={first || busy} onClick={() => onMove(-1)}>↑</button>
          <button type="button" aria-label={t("Move {{name}} down", { name: provider.name })} disabled={last || busy} onClick={() => onMove(1)}>↓</button>
        </span>
        <Switch label={provider.name} title={provider.available ? undefined : provider.unavailableReason ?? t("Needs its keys")} checked={provider.enabled && provider.available} disabled={!provider.available || busy} onChange={onToggle} />
        {keyed ? <button type="button" className="ks-fold" aria-label={open ? t("Close {{name}}", { name: provider.name }) : t("Open {{name}}", { name: provider.name })} aria-expanded={open} aria-controls={foldId} onClick={() => { setLoaded(true); setOpen(!open) }}>{open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}</button> : null}
      </div>
    </div>
    {problem ? <span className="z-err settings-src__err" role="alert">{problem}</span> : null}
    {keyed && loaded ? <div className="ka-sub settings-source__fold" id={foldId} hidden={!open}><Credentials provider={provider} /></div> : null}
  </div>
}

/** A source that is announced but not built yet: no switch, no order. */
function ComingSoon({ name, what }: { name: string; what: string }): React.JSX.Element {
  const { t } = useTranslation()
  return <div className="settings-source settings-source--soon">
    <div className="ks-row ks-src-row">
      <code className="ks-rank" />
      <div className="ks-l"><b title={what}>{name}</b></div>
      <div className="ks-c"><Word tone="off"><Dot tone="off" />{t("Coming soon")}</Word></div>
    </div>
  </div>
}

export function Sources({ kind: onlyKind, id = 'fuentes' }: { kind?: string; id?: SectionId } = {}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const providers = useProviders(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [problems, setProblems] = useState<Record<string, string>>({})

  const set = (next: Provider[]) => queryClient.setQueryData(queryKeys.server.providers(), next)

  const toggle = async (provider: Provider, enabled: boolean, offerUndo = true) => {
    setBusy(provider.id)
    setProblems((p) => ({ ...p, [provider.id]: '' }))
    try {
      await apiPut('/api/providers/{provider_id}', { params: { path: { provider_id: provider.id } }, body: { enabled } })
      set((providers.data ?? []).map((p) => (p.id === provider.id ? { ...p, enabled } : p)))
      void queryClient.invalidateQueries({ queryKey: queryKeys.server.providers() })
      toast(enabled ? t("{{name}} on", { name: provider.name }) : t("{{name}} off", { name: provider.name }), offerUndo ? { undo: () => void toggle(provider, !enabled, false) } : {})
    } catch {
      setProblems((p) => ({
        ...p,
        [provider.id]: t("Could not save the change"),
      }))
    } finally {
      setBusy(null)
    }
  }

  const move = async (group: Provider[], provider: Provider, delta: -1 | 1) => {
    const at = group.findIndex((p) => p.id === provider.id)
    const to = at + delta
    if (at < 0 || to < 0 || to >= group.length) return
    const order = group.map((p) => p.id)
    ;[order[at], order[to]] = [order[to], order[at]]
    setBusy(provider.id)
    try {
      await apiPut('/api/providers/{kind}/order', { params: { path: { kind: provider.kind as never } }, body: { order } })
      const position = new Map(order.map((id, i) => [id, i]))
      set((providers.data ?? []).map((p) => (position.has(p.id) ? { ...p, position: position.get(p.id) ?? p.position } : p)))
    } catch {
      toast(t("Could not save the order"), { err: true })
    } finally {
      setBusy(null)
    }
  }

  if (providers.isPending) {
    return (
      <Page id={id}>
        <SourceKeys />
        <div className="settings-block ks-group">
          <Skel rows={3} label={t("Loading the sources")} />
        </div>
      </Page>
    )
  }
  if (providers.isError) {
    return (
      <Page id={id}>
        <SourceKeys />
        <div className="settings-block ks-group">
          {isOlderNest(providers.error) ? (
            <OldNest>{t("Update the nest to choose its sources.")}</OldNest>
          ) : (
            <ErrorAlt what={t("the sources")} onRetry={() => void providers.refetch()} />
          )}
        </div>
      </Page>
    )
  }

  const all = providers.data
  const kinds = [...KINDS.map((k) => k.id), ...[...new Set(all.map((p) => p.kind))].filter((k) => !KINDS.some((x) => x.id === k)).sort()]
  return (
    <Page id={id} sub={onlyKind ? undefined : t("{{on}} of {{all}} on", { on: all.filter(p => p.enabled && p.available).length, all: all.length })}>
      <SourceKeys />
      {all.length === 0 ? (
        <div className="settings-block ks-group">
          <Empty action={<button className="ks-btn ks-btn--sm" type="button" onClick={() => void providers.refetch()}>{t("Retry")}</button>}>
            <span title={t("The nest did not load its sources. Restart it and try again.")}>{t("The nest has no sources registered.")}</span>

          </Empty>
        </div>
      ) : null}
      {kinds.filter(kind => !onlyKind || kind === onlyKind).map((kind) => {
        const group = all.filter((p) => p.kind === kind).sort((a, b) => a.position - b.position)
        if (group.length === 0 && !onlyKind) return null
        const meta = KINDS.find((k) => k.id === kind)
        const consulted = group.filter((p) => p.enabled && p.available)
        return (
          <div className="settings-block ks-group" key={kind}>
            <div className="settings-block__head">
              <h3>{meta ? <Tipped tip={t(meta.tip)}>{t(meta.label)}</Tipped> : kind}</h3>
              <span className="settings-count z-mono">{t("{{on}} of {{all}}", { on: consulted.length, all: group.length })}</span>
            </div>
            <div className="settings-block__body">
              {group.map((provider, index) => {
                const rank = consulted.findIndex((p) => p.id === provider.id)
                return (
                  <Row
                    key={provider.id}
                    provider={provider}
                    rank={rank < 0 ? null : rank + 1}
                    first={index === 0}
                    last={index === group.length - 1}
                    busy={busy !== null}
                    problem={problems[provider.id] || null}
                    onToggle={(next) => void toggle(provider, next)}
                    onMove={(delta) => void move(group, provider, delta)}
                  />
                )
              })}
              {kind === 'streaming' ? <ComingSoon name="Soulseek" what={t("lossless")} /> : null}
            </div>
          </div>
        )
      })}
    </Page>
  )
}

export function AudioSources(): React.JSX.Element { return <Sources kind="streaming" id="sources-audio" /> }
export function MetadataSources(): React.JSX.Element { return <Sources kind="metadata" id="sources-metadata" /> }
export function LyricsSources(): React.JSX.Element { return <Sources kind="lyrics" id="sources-lyrics" /> }
