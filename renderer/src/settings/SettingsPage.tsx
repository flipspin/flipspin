/** Settings stays inside the persistent app shell. At narrow widths,
 * the overview replaces the sidebar and each section returns to that index. */
import { LibraryHealth } from './sections/LibraryHealth'
import { useLibraryHealth, fixNowCount, healthSourceTitle, isFixNow } from './healthData'
import { Accuracy } from './sections/Accuracy'
import { Analysis, Estimates } from './sections/Analysis'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'

import '../ui/tokens/base.css'
import '../ui/tokens/personal.css'
import '../ui/tokens/modern.css'
import '../ui/primitives.css'
import '../ui/modern-primitives.css'
import './settings.css'
import './delete-account.css'

import { plugins, pluginAddons, pluginPages, pluginSettingsSections } from '../plugins'
import { useCurrentUser } from '../data'
import { isApiError } from '../data'
import { PairingProvider } from '../pairing'
import { routableAddress, useServerStatus } from './useInstall'
import { watchJobs } from '../lyrics/lyricsStore'
import { SettingsProvider, detectSurface, type SettingsContextValue, type SettingsHost, type Surface } from './context'
import { householdGateway, useServerUpdate, useServerStorage } from './data'
import { formatBytes } from './format'
import { nestWord, useNest } from './nest'
import { Dot, Skel, ToastProvider } from './parts'
import { SECTIONS, menuSection, resolveSection, sectionOf, type SectionId } from './sections'
import { Overview } from './sections/Overview'
import { Storage } from './sections/Storage'
import { ThisComputer } from './sections/ThisComputer'
import { MyAccount, MyDevices } from './sections/MyAccount'
import { NestStatus } from './sections/NestStatus'
import { LiveUpdatesLost } from './LiveUpdates'
import { Duplicates } from './sections/Duplicates'
import { Library } from './sections/Library'
import { MissingFiles } from '../library/MissingFiles'
import { RemoteAccess } from './sections/RemoteAccess'
import { Accounts } from './sections/Accounts'
import { Sources, AudioSources, MetadataSources, LyricsSources } from './sections/Sources'
import { BackgroundWork } from './background/BackgroundWork'
import { useCompute } from './background/data'
import { Lyrics } from './sections/Lyrics'
import { Addons } from './sections/Addons'
import { ConfigProvider, useConfig } from './config'
import { Performance } from './sections/Performance'
import { Network } from './sections/Network'
import { Security } from './sections/Security'
import { Logs } from './sections/Logs'
import { StemSeparation } from './sections/StemSeparation'
import { Missing } from '../ui/react/components/Missing'
import { Plugins, Ties, Recommendations } from './sections/Plugins'
import { settingsMenuKey, useSettingsMenu } from './useSettingsMenu'

const PAGES: Record<SectionId, () => React.JSX.Element> = {
  'resumen': Overview,
  'complementos': Addons,
  plugins: Plugins,
  ties: Ties,
  recommendations: Recommendations,
  'sources-audio': AudioSources,
  'sources-metadata': MetadataSources,
  'sources-lyrics': LyricsSources,
  'equipo': ThisComputer,
  'almacenamiento': Storage,
  'cuenta': MyAccount,
  'dispositivos': MyDevices,
  'nido': NestStatus,
  'biblioteca': Library,
  health: LibraryHealth,
  duplicates: Duplicates,
  missing: MissingFiles,
  'remoto': RemoteAccess,
  'cuentas': Accounts,
  'fuentes': Sources,
  'letras': Lyrics,
  'letras-nido': Lyrics,
  'equipos': BackgroundWork,
  stems: StemSeparation,
  'analisis': Analysis,
  estimates: Estimates,
  accuracy: Accuracy,
  'registro': Logs,
  performance: Performance,
  network: Network,
  security: Security,
}

export interface SettingsPageProps {
  /** Where to open. Anything the old modal took is understood; default "Overview". */
  initialSection?: string | null
  host: SettingsHost
  /** Detected from the shell; a test may force it. */
  surface?: Surface
}

function useNarrow(): boolean {
  const query = '(max-width: 899px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const on = () => setNarrow(list.matches)
    list.addEventListener?.('change', on)
    return () => list.removeEventListener?.('change', on)
  }, [])
  return narrow
}

export function SettingsPage({ initialSection, host, surface: forced }: SettingsPageProps): React.JSX.Element {
  const { t } = useTranslation()
  const surface = forced ?? detectSurface()
  const pluginIds = useMemo(() => [...plugins, ...pluginAddons, ...pluginPages, ...pluginSettingsSections].map((entry) => entry.id), [])
  const [section, setSection] = useState<SectionId>(() => resolveSection(initialSection ?? window.location.hash, pluginIds))
  const [pluginTarget, setPluginTarget] = useState(() => {
    const raw = (initialSection ?? window.location.hash).replace(/^#\/(?:ajustes|settings)\//, '')
    return pluginAddons.find(card => card.id === raw || card.open.id === raw)?.id
  })
  const content = useRef<HTMLElement>(null)
  const narrow = useNarrow()

  const me = useCurrentUser()
  const admin = me.isPending ? null : me.data?.isOwner === true
  const meStatus = me.error && isApiError(me.error) ? (me.error.status ?? null) : null
  const server = useServerStatus()

  const go = useCallback((id: SectionId) => {
    // In-page shortcuts disappear with their section. Keep keyboard focus in
    // the content pane; sidebar controls keep their own focus.
    if (content.current?.contains(document.activeElement)) content.current.focus({ preventScroll: true })
    // Reselecting the current section is also a jump back to its start.
    if (content.current) content.current.scrollTop = 0
    setSection(resolveSection(id))
    setPluginTarget(undefined)
  }, [])

  // Library health explains a refused deep link; other admin links return to Summary.
  const shown: SectionId = admin === false && sectionOf(section).admin && section !== 'health' ? 'resumen' : section
  const waitingForRole = admin === null && sectionOf(section).admin

  useLayoutEffect(() => {
    // Reset after the new section commits, before paint and deep-link focus.
    if (content.current) content.current.scrollTop = 0
  }, [shown])

  useEffect(() => {
    if (initialSection !== 'version' || shown !== 'nido') return
    // Focus the legacy deep link after its destination has rendered.
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById('aj-version')
      card?.scrollIntoView?.({ block: 'start' })
      card?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [initialSection, shown])

  useEffect(() => {
    if (shown !== 'dispositivos') return
    const frame = requestAnimationFrame(() => {
      const list = document.getElementById('aj-dispositivos')
      list?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [shown, me.data])

  const context = useMemo<SettingsContextValue>(
    () => ({ surface, admin, me: me.data ?? null, meStatus, mePending: me.isPending, meError: me.error, refreshMe: me.refetch, server: server.state, refreshServer: server.refresh, host, go }),
    [surface, admin, me.data, meStatus, me.isPending, me.error, me.refetch, server.state, server.refresh, host, go],
  )

  const pairingUrl = routableAddress(server.state.kind === 'ready' ? server.state.value : null)
  const gateway = useMemo(() => householdGateway(), [])
  const Page = PAGES[shown]
  const def = sectionOf(shown)
  const menuKey = settingsMenuKey(server.state.kind === 'ready' ? server.state.value?.instanceId ?? server.state.value?.baseUrl ?? null : null, me.data?.id ?? null)

  return (
    <SettingsProvider value={context}>
      <PairingProvider gateway={gateway} serverUrl={pairingUrl}>
        <div className="settings krobi-settings z-root" data-profile="krobi" data-page={shown}>
          <ToastProvider>
            <ConfigProvider>
              {narrow ? <header className="z-topbar settings-top">
                {narrow && shown !== 'resumen' ? <button
                  className="settings-top__back"
                  type="button"
                  title={t("Back to Settings")}
                  onClick={() => {
                    content.current?.focus({ preventScroll: true })
                    go('resumen')
                  }}
                >
                  <ChevronLeft className="i" aria-hidden />
                  <span>{t("Settings")}</span>
                </button> : null}
                <h1 className="settings-top__title">
                  <span className="settings-top__crumb">{t("Settings")}</span>
                  <span className="settings-top__here">{shown === 'resumen' ? '' : t(def.title ?? def.label)}</span>
                </h1>
              </header> : null}
              <div className="settings-body">
                <Nav storageKey={menuKey} current={shown} admin={admin === true} onGo={go} pluginTarget={pluginTarget} onPlugin={id => { go('plugins'); setPluginTarget(id) }} />
                <main className="settings-main" ref={content} tabIndex={-1}>
                  {waitingForRole ? (
                    <section className="settings-page" aria-busy="true">
                      <h2 className="settings-h">{t(def.title ?? def.label)}</h2>
                      <div className="settings-block">
                        <Skel rows={3} />
                      </div>
                    </section>
                  ) : (
                    shown === 'plugins' ? <Plugins key={pluginTarget ?? shown} target={pluginTarget} /> : <Page key={shown} />
                  )}
                </main>
              </div>
            </ConfigProvider>
          </ToastProvider>
        </div>
      </PairingProvider>
    </SettingsProvider>
  )
}

function Nav({ current, admin, onGo, storageKey, pluginTarget, onPlugin }: { current: SectionId; admin: boolean; onGo: (id: SectionId) => void; storageKey: string; pluginTarget?: string; onPlugin: (id: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { expanded, toggle, show } = useSettingsMenu(storageKey, current)
  const { query: config } = useConfig()
  const pending = config.data?.restart.pending.length ?? 0
  useEffect(() => (admin ? watchJobs() : undefined), [admin])
  const compute = useCompute(admin)
  const helperBadge = compute.data?.waiting ?? 0
  const health = useLibraryHealth(admin)
  const healthBadge = fixNowCount(health.data)
  const healthTitle = health.data?.checks.filter(isFixNow).map(c => healthSourceTitle(c.source)).join('\n')
  const visible = SECTIONS.filter((section) => admin || !section.admin)
  const groups = [
    { id: 'top', label: null }, { id: 'music', label: t("Nest") },
    { id: 'features', label: t("Features") }, { id: 'household', label: t("Access") },
    { id: 'computer', label: t("This computer") },
    { id: 'system', label: t("System_system") },
  ]

  const item = (id: SectionId) => {
    const section = sectionOf(id)
    const Icon = section.icon
    const badge = id === 'performance' ? pending : id === 'equipos' ? helperBadge : id === 'health' ? healthBadge : 0
    return (
      <button
        key={id}
        type="button"
        className={`settings-nav__item${section.parent ? ' settings-nav__item--sub' : ''}`}
        title={id === 'equipos' && helperBadge ? t("{{n}} waiting", { n: helperBadge }) : undefined}
        aria-current={menuSection(current) === id ? 'page' : current === id ? 'location' : undefined}
        style={{ '--_c': section.hue, '--_t': section.tint } as React.CSSProperties}
        onClick={() => { show(id); onGo(id) }}
      >
        {!section.parent ? <span className="settings-nav__tile" aria-hidden>
          <Icon className="i" />
        </span> : null}
        {t(section.label)}
        {badge > 0 ? (
          <span className="settings-nav__badge" title={id === 'health' ? healthTitle : id === 'performance' ? t("Restart the nest to apply {{n}} changes", { count: pending, n: pending }) : t("{{n}} waiting", { n: helperBadge })}>
            {badge}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <nav className="settings-nav" aria-label={t("Settings sections")}>
      {groups.filter(group => visible.some(section => section.group === group.id)).map(group => <div className="settings-nav__scope" key={group.id}>
        {group.label ? <span className="z-eyebrow settings-nav__group">{group.label}</span> : null}
        {visible.filter(section => section.group === group.id).map(section => {
          const children = visible.filter(child => child.parent === section.id)
          const cards = section.id === 'plugins' ? pluginAddons : []
          if (!children.length && !cards.length) return item(section.id)
          const controls = `settings-nav-${section.id}`
          const open = expanded[section.id] === true
          return <div className="settings-nav__branch" key={section.id}>
            <div className="settings-nav__parent">
              {item(section.id)}
              <button type="button" className="settings-nav__toggle" aria-label={t('Show or hide {{section}}', { section: t(section.label) })} aria-expanded={open} aria-controls={controls} onClick={() => toggle(section.id)}>
                {open ? <ChevronDown className="i" aria-hidden /> : <ChevronRight className="i" aria-hidden />}
              </button>
            </div>
            <div id={controls} className="settings-nav__children" hidden={!open}>
              {children.map(child => item(child.id))}
              {cards.map(card => <button key={card.id} type="button" className="settings-nav__item settings-nav__item--sub" aria-current={current === 'plugins' && pluginTarget === card.id ? 'location' : undefined} onClick={() => onPlugin(card.id)}>{t(card.name)}</button>)}
            </div>
          </div>
        })}
      </div>)}
      <NavFoot admin={admin} onGo={onGo} />
    </nav>
  )
}

function NavFoot({ admin, onGo }: { admin: boolean; onGo: (id: SectionId) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const server = useServerStatus()
  const nest = useNest(server.state)
  const storage = useServerStorage(admin)
  const update = useServerUpdate(admin).data
  const state = nestWord(nest.kind)
  return (
    <div className="settings-nav__foot">
      <span className="settings-vital">
        <Dot tone={state.tone} />
        <b>{t(state.word)}</b>
        <span className="z-mono settings-vital__v">{nest.version ? `v${nest.version}` : <Missing kind="nodata" />}</span>
        {update?.checking && update.updateAvailable ? <button type="button" className="settings-mark" title={t("New version of Flipspin")} onClick={() => onGo('nido')}>→ {update.latest}</button> : null}
      </span>
      <LiveUpdatesLost />
      {admin ? (
        <div className="settings-vital__disk">
          <span className="settings-vital__k">{t("Storage")}</span>
          <span className="z-mono">
            {storage.data
              ? t("Flipspin {{size}} · {{free}} free", { size: formatBytes(storage.data.music + storage.data.stems), free: formatBytes(storage.data.disk.free) })
              : <Missing kind={storage.isPending ? 'loading' : 'nodata'} />}
          </span>
          <div className="z-meter" title={storage.data ? t("Nest disk: {{free}} free of {{total}}", { free: formatBytes(storage.data.disk.free), total: formatBytes(storage.data.disk.total) }) : undefined}>
            <i style={{ width: storage.data && storage.data.disk.total > 0 ? `${Math.max(0, Math.min(100, (1 - storage.data.disk.free / storage.data.disk.total) * 100))}%` : '0%' }} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
