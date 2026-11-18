import { useKnownSources } from '../sourceInstall'
import { KnownSourceRow } from './SourceInstaller'
/**
 * "Overview": the nest drawn (name, state, version, disk), what needs a hand
 * first, then every section with its current value; the landing of Settings,
 * and the whole menu on a phone.
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Server } from 'lucide-react'

import { LANGUAGE_NAMES, currentLanguage, msg } from '../../i18n'
import { pluginAddons } from '../../plugins'
import { useLyricsJobs, useLyricsJobsError, useLyricsJobsFailure, refreshJobs, watchJobs } from '../../lyrics/lyricsStore'
import { networkReach, reachKey, ROW_LABEL, useNestAddresses } from '../../remote/useNestAddresses'
import { ROLE_NAMES } from '../../pairing'
import { CAPACITY_KEYS, capacityPresets, useConfig } from '../config'
import { PRESETS } from '../configWords'
import { useSettings } from '../context'
import { useAccounts, useAnalysisTags, useLibrarySummary, useLog, useMyDevices, useProviders, useServerUpdate, useServerStorage, type ServerStorage } from '../data'
import { engineWord, waiting } from '../engine'
import { formatAgo, formatBytes, formatCount } from '../format'
import { errorsToday } from '../logs'
import { nestWord, useNest } from '../nest'
import { useCompute } from '../background/data'
import { Dot, QueryFailure, Skel } from '../parts'
import { useLastReach } from '../reachMemo'
import { SECTIONS, sectionOf, type SectionId } from '../sections'
import { Page } from './Head'
import { sourceFact, sourceNeedsAction, sourceState, sourceWord } from '../sourceHealth'
import { RetrySource, SourceStatus } from './SourceHealth'
import { missingWord } from '../../ui/react/components/missingWords'

/** The storage Flipspin measures, in legend order. */
export function diskSlices(storage: ServerStorage) {
  return [
    { key: 'music', label: msg("Music"), bytes: storage.music, hue: 'var(--accent-yellow)' },
    { key: 'stems', label: msg('Stems'), bytes: storage.stems, hue: 'var(--accent-purple)' },
  ] as const
}

/** The stacked bar: each slice solid in its hue, as a share of the disk. */
export function DiskBar({ storage, big = false }: { storage: ServerStorage; big?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const total = storage.disk.total
  const size = storage.music + storage.stems
  const otherUsed = Math.max(0, total - storage.disk.free - size)
  return (
    <div
      className={`settings-disk${big ? ' settings-disk--big' : ''}`}
      role="img"
      aria-label={t("Flipspin {{size}} · Disk {{free}} free of {{total}}", { size: formatBytes(size), free: formatBytes(storage.disk.free), total: formatBytes(total) })}
    >
      {diskSlices(storage).map((slice) => (
        <i
          key={slice.key}
          title={`${t(slice.label)} · ${formatBytes(slice.bytes)}`}
          style={{ '--_c': slice.hue, width: total > 0 ? `${(slice.bytes / total) * 100}%` : '0%' } as React.CSSProperties}
        />
      ))}
      <i
        title={t("In use by other programs or the system")}
        style={{ '--_c': 'var(--color-text-tertiary)', width: total > 0 ? `${(otherUsed / total) * 100}%` : '0%' } as React.CSSProperties}
      />
    </div>
  )
}

const NEST_HUE = { '--_c': 'var(--accent-teal)' } as React.CSSProperties

export function NestCard({ big = false, children }: { big?: boolean; children?: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const { server, admin } = useSettings()
  const nest = useNest(server)
  const storage = useServerStorage(admin === true && !big)
  const state = nestWord(nest.kind)

  if (nest.kind === 'loading') {
    return (
      <div className={`settings-nest${big ? ' settings-nest--big' : ''}`} style={NEST_HUE}>
        <Skel rows={3} label={t("Loading the nest’s status")} />
      </div>
    )
  }

  if (nest.kind === 'offline') {
    return (
      <div className={`settings-nest${big ? ' settings-nest--big' : ''}`} style={NEST_HUE}>
        <div className="settings-alt" role="alert">
          <Dot tone="bad" />
          <b>{t("No answer")}</b>
          <span className="z-say">
            {nest.address ? t("The nest is not responding at {{address}}.", { address: nest.address }) : t("The nest is not responding.")}
          </span>
          <button className="z-btn z-btn--sm" type="button" onClick={nest.retry}>
            {t("Retry")}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`settings-nest${big ? ' settings-nest--big' : ''}`} style={NEST_HUE}>
      <div className="settings-nest__mark" aria-hidden>
        <Server className="i" />
      </div>
      <div className="settings-nest__id">
        {children ?? <span className="settings-nest__name">{nest.name ?? t("Your nest")}</span>}
        <span className="settings-nest__facts">
          <Dot tone={state.tone} />
          <b>{t(state.word)}</b>
          {big ? (
            <span title={new Date(nest.checkedAt).toLocaleString()}>· {t("checked {{ago}}", { ago: formatAgo(nest.checkedAt) })}</span>
          ) : (
            <>
              {nest.version ? <span className="z-mono">· v{nest.version}</span> : null}
              {nest.address ? <span className="z-mono">· {nest.address}</span> : null}
            </>
          )}
        </span>
      </div>
      {!big && admin === true ? (
        <div className="settings-nest__disk">
          {storage.data ? (
            <>
              <DiskBar storage={storage.data} />
              <span className="settings-disk__sum">
                {t("Flipspin {{size}} · Disk {{free}} free of {{total}}", { size: formatBytes(storage.data.music + storage.data.stems), free: formatBytes(storage.data.disk.free), total: formatBytes(storage.data.disk.total) })}
              </span>
            </>
          ) : storage.isPending ? (
            <Skel rows={1} />
          ) : (
            <span className="settings-disk__sum" title={t("Update the nest to see storage")}>
              {t("Storage")} —
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}

interface Todo {
  id: string
  to: SectionId
  what: string
  value: string
  hue: string
}

function Pendiente(): React.JSX.Element {
  const { t } = useTranslation()
  const { go, admin } = useSettings()
  const update = useServerUpdate(admin === true).data
  const compute = useCompute(admin === true).data
  const providers = useProviders(admin === true)
  const known = useKnownSources(admin === true)
  // An installed source is done; a finished attempt must not keep its to-do row.
  const missing = known.data?.sources.filter(source => !source.installed) ?? []
  const sourceTodos = (providers.data ?? []).filter(provider => sourceNeedsAction(provider))
  const jobs = useLyricsJobs()
  const jobsError = useLyricsJobsError()
  const jobsFailure = useLyricsJobsFailure()
  const network = useNestAddresses()
  const storage = useServerStorage(true)
  const lastReach = useLastReach(reachKey(network.network, network.instanceId))
  const reach = lastReach ?? networkReach(network.network).reach

  const { query: config } = useConfig()
  const pending = config.data?.restart.pending.length ?? 0
  const todos: Todo[] = []
  if (update?.checking && update.updateAvailable) todos.push({ id: 'update', to: 'nido', what: t("New version of Flipspin"), value: `${update.current} → ${update.latest}`, hue: 'var(--accent-teal)' })
  if (pending > 0) todos.push({ id: 'config', to: 'performance', what: t("Restart the nest to apply {{n}} changes", { count: pending, n: pending }), value: t("Performance"), hue: 'var(--accent-rose)' })
  for (const computer of compute?.computers ?? []) {
    if (admin === true && computer.versionState === 'too-old' && computer.state !== 'revoked') todos.push({
      id: `helper-${computer.id}`, to: 'equipos', what: t("{{name}} is too old for this nest", { name: computer.nest ? t("The nest") : computer.name }),
      value: t("Needs {{minimum}} or newer · not taking work", { minimum: computer.minimumVersion }), hue: 'var(--status-danger)',
    })
  }
  const engine = engineWord(jobs?.engine)
  if (engine?.stopped && waiting(jobs) > 0) {
    todos.push({ id: 'engine', to: 'equipos', what: t("Lyrics engine stopped"), value: t("{{n}} pending songs", { count: waiting(jobs), n: formatCount(waiting(jobs)) }), hue: 'var(--status-warning)' })
  }
  const outside = reach !== 'local'
  if (outside && (reach === null || reach === 'none')) {
    todos.push({ id: 'remote', to: 'remoto', what: t("Remote access not checked"), value: '', hue: 'var(--color-text-tertiary)' })
  } else if (outside && reach === 'bad') {
    todos.push({ id: 'remote', to: 'remoto', what: t("Not reachable from outside"), value: '', hue: 'var(--status-danger)' })
  }
  if (storage.data && storage.data.disk.total > 0 && storage.data.disk.free / storage.data.disk.total < 0.1) {
    todos.push({ id: 'disk', to: 'biblioteca', what: t("Storage almost full"), value: t("{{free}} free", { free: formatBytes(storage.data.disk.free) }), hue: 'var(--status-danger)' })
  }

  const loading = (jobs === null && !jobsError) || network.loading
  const count = todos.length + sourceTodos.length + missing.length
  return (
    <div className="settings-block ks-group" style={{ '--_c': 'var(--accent-coral)' } as React.CSSProperties}>
      <div className="settings-block__head">
        <h3>{t("To do")}</h3>
        {!loading && count > 0 ? <span className="settings-count z-mono">{count}</span> : null}
      </div>
      {loading && count === 0 ? (
        <Skel rows={2} />
      ) : jobsError && count === 0 ? (
        <QueryFailure error={jobsFailure} what={t("the library’s lyrics")} onRetry={() => void refreshJobs()} />
      ) : network.error && count === 0 ? (
        <QueryFailure error={network.error} what={t("the nest’s addresses")} onRetry={() => void network.refresh()} />
      ) : count === 0 ? (
        <div className="settings-alt">
          <Dot tone="ok" />
          <b>{t("Nothing to do")}</b>
        </div>
      ) : (
        <div className="settings-block__body">
          {missing.map(source => <KnownSourceRow key={source.id} source={source} todo />)}
          {sourceTodos.map(provider => {
            const state = sourceState(provider)
            const healthIssue = state !== 'ready' && (state !== 'busy' || (provider.health?.since != null && Date.now() / 1000 - provider.health.since > 6 * 3600))
            return <div key={`source-${provider.id}`} className="ks-row">
              <div className="ks-l"><b>{healthIssue ? t('{{name}} · {{state}}', { name: provider.name, state: sourceWord(provider, t) }) : provider.name}</b><span>{healthIssue ? sourceFact(provider, t) : provider.status?.warning}</span></div>
              <div className="ks-c">{healthIssue ? <SourceStatus provider={provider} /> : null}{healthIssue && state !== 'auth' ? <RetrySource provider={provider} /> : null}<button type="button" className="ks-link" onClick={() => go('sources-audio')}>{t('Open Sources')}</button></div>
            </div>
          })}
          {todos.map((todo) => (
            <button key={todo.id} type="button" className="settings-todo" style={{ '--_c': todo.hue } as React.CSSProperties} onClick={() => go(todo.to)}>
              <span className="z-dot" />
              <span className="settings-todo__what">{todo.what}</span>
              <span className={`settings-todo__v${todo.id === 'update' ? ' z-mono' : ''}`}>{todo.value}</span>
              <ChevronRight className="i" aria-hidden />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Each section's current value, as one short line. Empty while it loads. */
function useValues(admin: boolean): Partial<Record<SectionId, string>> {
  const { t } = useTranslation()
  const { host, me, server } = useSettings()
  const nest = useNest(server)
  const own = me?.source === 'token'
  const devices = useMyDevices(own)
  const summary = useLibrarySummary(admin)
  const accounts = useAccounts(admin)
  const providers = useProviders(admin)
  const tags = useAnalysisTags(admin)
  const log = useLog('errors', '', admin)
  const network = useNestAddresses()
  const jobs = useLyricsJobs()

  const { query: config } = useConfig()
  const values: Partial<Record<SectionId, string>> = {
    'complementos': [t("Lyrics_plural"), t('Stems'), t("Analysis")].join(' · '),
    plugins: [t('Ties'), t('Recommendations'), ...pluginAddons.map(card => t(card.name))].join(' · '),
    'equipo': `${LANGUAGE_NAMES[currentLanguage()]} · ${t(host.mode === 'night' ? "Night" : host.mode === 'dark' ? "Dark" : "Light")}`,
  }
  if (config.data) {
    const capacity = config.data.groups.find((g) => g.id === 'capacity')?.settings ?? []
    const download = capacity.find((r) => r.key === CAPACITY_KEYS[0])?.value
    const preset = Object.entries(capacityPresets(config.data)).find(([, values]) =>
      CAPACITY_KEYS.every((key) => capacity.find((r) => r.key === key)?.value === values[key]),
    )?.[0]
    values.performance = [t(PRESETS[preset] ?? "Custom"), t("{{n}} at a time per source", { count: Number(download), n: download })].join(' · ')
  }
  if (me) {
    const role = t(me.isOwner ? ROLE_NAMES.owner : ROLE_NAMES.member)
    const parts = [me.label, role]
    if (own && devices.data) values.dispositivos = t("{{n}} devices", { count: devices.data.length, n: devices.data.length })
    values.cuenta = parts.join(' · ')
  }
  if (nest.kind !== 'loading') values.nido = [t(nestWord(nest.kind).word), nest.version ? `v${nest.version}` : null].filter(Boolean).join(' · ')
  if (summary.data) values.biblioteca = t("{{n}} songs", { count: summary.data.songs, n: formatCount(summary.data.songs) })
  if (network.network) {
    const kinds = [...new Set(network.rows.map((row) => row.label))]
    values.remoto = kinds.map((label) => (label === ROW_LABEL.lan ? t("Local network") : t(label))).join(' · ') || missingWord('nodata')
  }
  if (accounts.data) {
    const admins = accounts.data.filter((a) => a.role === 'owner').length
    values.cuentas = `${t("{{n}} accounts", { count: accounts.data.length, n: accounts.data.length })} · ${t("{{n}} admins", { count: admins, n: admins })}`
  }
  if (providers.data) {
    const on = providers.data.filter((p) => p.enabled && p.available).length
    values.fuentes = t("{{on}} of {{all}} on", { on, all: providers.data.length })
  }
  if (jobs && summary.data) values.letras = t("{{n}} of {{total}} with lyrics", { n: formatCount(jobs.withLyrics), total: formatCount(summary.data.songs) })
  else if (jobs) values.letras = t("{{n}} with lyrics", { n: formatCount(jobs.withLyrics) })
  if (tags.data !== undefined) values.analisis = tags.data ? t("saved in files") : t("not saved in files")
  if (log.data) {
    const n = errorsToday(log.data.lines)
    values.registro = n === 0 ? t("no errors today") : t("{{n}} errors today", { count: n, n })
  }
  return values
}

export function Overview(): React.JSX.Element {
  const { t } = useTranslation()
  const { admin, go } = useSettings()
  const isAdmin = admin === true
  useEffect(() => (isAdmin ? watchJobs() : undefined), [isAdmin])
  const values = useValues(isAdmin)
  const visible = SECTIONS.filter((section) => section.id !== 'resumen' && (isAdmin || !section.admin))
  const groups = [
    { label: t("Nest"), id: 'music' },
    { label: t("Features"), id: 'features' },
    { label: t("Access"), id: 'household' },
    { label: t("This computer"), id: 'computer' },
    { label: t("System_system"), id: 'system' },
  ].map(group => ({ ...group, ids: visible.filter(section => section.group === group.id).map(section => section.id) })).filter(group => group.ids.length)

  return (
    <Page id="resumen">
      <NestCard />
      {isAdmin ? <Pendiente /> : null}
      <div className="settings-index">
        {groups.map((group) => (
          <div className="settings-index__group" key={group.label}>
            <span className="z-eyebrow">{group.label}</span>
            {group.ids.map((id) => {
              const section = sectionOf(id)
              return (
                <button key={id} type="button" className="settings-irow" onClick={() => go(id)}>
                  <span className="settings-index-dot" style={{ '--_c': section.hue } as React.CSSProperties} aria-hidden />
                  <span className="settings-irow__k">{t(section.label)}</span>
                  <span className="settings-irow__v">{values[id] ?? ''}</span>
                  <ChevronRight className="i" aria-hidden />
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </Page>
  )
}
