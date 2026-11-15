import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { QueryFailure, Dot } from '../parts'
import { Sheet } from '../background/controls'
import { closePluginInstaller } from '../sourceInstaller'
import { msg } from '../../i18n'
import { useKnownSources, useSourceInstall, type KnownSource } from '../sourceInstall'

const PHASES: Record<string, { word: string; step: number }> = {
  fetch: { word: msg('Downloading'), step: 1 },
  validate: { word: msg('Setting up'), step: 2 }, build: { word: msg('Setting up'), step: 2 },
  hello: { word: msg('Checking'), step: 3 }, test: { word: msg('Checking'), step: 3 }, publish: { word: msg('Checking'), step: 3 },
}

function InstallState({ state, installed = false, secondary = false, disabled = false, onInstall }: {
  state: ReturnType<typeof useSourceInstall>; installed?: boolean; secondary?: boolean; disabled?: boolean; onInstall: () => void
}) {
  const { t } = useTranslation()
  const phase = PHASES[state.job?.phase ?? 'fetch'] ?? PHASES.fetch
  if (state.busy) return <div className="settings-source-progress"><div className="z-meter" role="progressbar" aria-label={t('Installing the plugin')} aria-valuemin={0} aria-valuemax={3} aria-valuenow={phase.step}><i style={{ width: `${(phase.step - 1) / 3 * 100}%` }} /></div><span>{t('{{step}} · {{count}} of 3', { step: t(phase.word), count: phase.step })}</span></div>
  if (installed || state.succeeded) return <span className="settings-source-status"><Dot tone="ok" />{t('Installed')}</span>
  if (state.failed) return <><span className="settings-source-status"><Dot tone="bad" />{t('Failed')}</span><button type="button" className="ks-btn" onClick={onInstall}>{t('Retry')}</button></>
  return <button type="button" className={`ks-btn${secondary ? '' : ' settings-source-install'}`} disabled={disabled} onClick={onInstall}>{t('Install')}</button>
}

function InstallFailure({ state, installed = false }: { state: ReturnType<typeof useSourceInstall>; installed?: boolean }) {
  const { t } = useTranslation()
  if (!state.failed || installed) return null
  const network = /could not resolve|unable to access|network|connection|timed? ?out/i.test(state.reason)
  return <p className="settings-source-failure" role="alert" title={state.reason}>{network ? t("The server couldn't reach GitHub.") : t("The server couldn't install the source.")}</p>
}

export function KnownSourceRow({ source, todo = false }: { source: KnownSource; todo?: boolean }) {
  const { t } = useTranslation()
  const state = useSourceInstall(source.id)
  return <div className="settings-source">
    <div className={todo ? 'ks-row' : 'ks-row settings-source-row'}>
      {!todo ? <span className="settings-source-tile" aria-hidden><Play className="i" fill="currentColor" /></span> : null}
      <div className="ks-l"><b>{todo ? t('Install the {{name}} source', { name: source.name }) : source.name}</b><span>{todo ? t('No source can download songs yet') : source.facts.map(fact => t(fact)).join(' · ')}</span></div>
      <div className="ks-c"><InstallState state={state} installed={source.installed} onInstall={() => void state.install({ id: source.id })} /></div>
    </div>
    <InstallFailure state={state} installed={source.installed} />
  </div>
}

export function SourceInstaller({ open, initialLocation, progressId }: { open: boolean; initialLocation: string; progressId?: string }) {
  const { t } = useTranslation()
  const [location, setLocation] = useState(initialLocation)
  const sources = useKnownSources(open)
  const known = sources.data?.sources.find(source => [source.id, source.name].some(value => value.toLowerCase() === location.trim().toLowerCase()))
  const state = useSourceInstall(known?.id ?? `other:${location.trim()}`, progressId)
  function install() { void state.install(known ? { id: known.id } : { location: location.trim() }) }
  return <Sheet open={open} title={t('Add a plugin')} onClose={closePluginInstaller}>
    <div className="settings-block__head"><h3>{t('Sources')}</h3></div>
    {sources.data?.sources.map(source => <KnownSourceRow key={source.id} source={source} />)}
    {sources.isError ? <QueryFailure error={sources.error} what={t('Sources')} onRetry={() => void sources.refetch()} /> : null}
    <details className="settings-source-other" open={initialLocation || progressId ? true : undefined}>
      <summary>{t('Other source')}</summary>
      <form className="settings-source-form" onSubmit={event => { event.preventDefault(); if (!state.busy && !known?.installed && !state.succeeded && location.trim()) install() }}>
        <div className="ks-row"><label className="ks-l" htmlFor="plugin-location"><b>{t('Git URL or folder on the server')}</b></label><div className="ks-c"><input id="plugin-location" className="ks-field ks-field--mono" value={location} disabled={state.busy} onChange={event => setLocation(event.target.value)} /><InstallState state={state} installed={known?.installed} secondary disabled={!location.trim()} onInstall={install} /></div></div>
        {known ? <p>{t('Installs the {{name}} source above', { name: known.name })}</p> : null}
        {!known ? <InstallFailure state={state} /> : null}
        {state.jobs.isError ? <QueryFailure error={state.jobs.error} what={t('the jobs')} onRetry={() => void state.jobs.refetch()} /> : null}
      </form>
    </details>
  </Sheet>
}
