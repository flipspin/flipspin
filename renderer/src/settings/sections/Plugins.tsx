import { useHeld } from '../../ui/react/useHeld'
import { useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiPost, queryKeys, isApiError } from '../../data'
import { Modal, Switch, useToast } from '../parts'
import { Missing } from '../../ui/react/components/Missing'
import { ExtensionState, type Extension } from '../extensions'
import { openPluginInstaller, closePluginInstaller, usePluginInstaller } from '../sourceInstaller'
import { KnownSourceRow, SourceInstaller } from './SourceInstaller'
import { Credentials, useSourceToggle } from './Sources'
import { RetrySource, SourceStatus } from './SourceHealth'
import { sourceState } from '../sourceHealth'
import { useKnownSources } from '../sourceInstall'
import { useTranslation } from 'react-i18next'
import { GitFork, Play, Puzzle, Sparkles } from 'lucide-react'
import { pluginAddons } from '../../plugins'
import { Page } from './Head'
import { AddonCard, AddonRow } from './AddonCard'
import { PluginAddon } from './PluginAddon'
import { useExtensions, useProviders } from '../data'
import { useSettings } from '../context'
import { openSettings } from '../../shell/ServerBadge'

function InstalledSource({ extension, onUpdate }: { extension: Extension; onUpdate: (id: string, location: string) => void }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  // Everything about this source lives on this card: state, switch, sign-in, version, update and removal.
  const provider = useProviders(true).data?.find(row => row.id === extension.id)
  const { busy: switching, problems, toggle } = useSourceToggle()
  const [signIn, setSignIn] = useState(false)
  const signInId = useId()
  const [busy, setBusy] = useState(false)
  async function update() {
    setBusy(true)
    try {
      const response = await apiPost('/api/sources/{id}/update', { params: { path: { id: extension.id } } })
      onUpdate(response.progress_id, '')
    } catch (error) { toast(isApiError(error) ? error.userMessage : t('Could not update the plugin'), { err: true }) }
    finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true)
    try {
      await apiDelete('/api/sources/{id}', { params: { path: { id: extension.id } } })
      setConfirm(false)
      await client.invalidateQueries({ queryKey: queryKeys.server.extensions() })
      await client.invalidateQueries({ queryKey: queryKeys.server.providers() })
      client.setQueryData<Record<string, unknown>>(['source-install-attempts'], previous => { const next = { ...previous }; delete next[extension.id]; return next })
      await client.invalidateQueries({ queryKey: ['missing-sources'] })
      await client.invalidateQueries({ queryKey: ['known-sources'] })
    } catch (error) { toast(isApiError(error) ? error.userMessage : t('Could not remove the plugin'), { err: true }) }
    finally { setBusy(false) }
  }
  // Each installed source is its own card, like the other plugins, with its actions on its row.
  return <AddonCard name={extension.name} kind={t("Audio source")} icon={Play}>
    {provider ? <div className="ks-row"><div className="ks-l"><b>{t("Status")}</b></div><div className="ks-c">
      {provider.enabled ? <SourceStatus provider={provider} /> : null}
      {provider.enabled && ['busy', 'broken'].includes(sourceState(provider)) ? <RetrySource provider={provider} /> : null}
      <Switch label={provider.name} title={provider.available ? undefined : provider.unavailableReason ?? undefined} checked={provider.enabled && provider.available} disabled={!provider.available || switching !== null} onChange={next => void toggle(provider, next)} />
    </div></div> : null}
    {provider && problems[provider.id] ? <span className="z-err settings-src__err" role="alert">{problems[provider.id]}</span> : null}
    <div className="ks-row"><div className="ks-l"><b>{t("In the nest")}</b><span><code>{extension.version ?? <Missing kind="nodata" />}</code></span></div><div className="ks-c"><ExtensionState extension={extension} /><button type="button" className="ks-link" disabled={busy} onClick={() => void update()}>{t('Update')}</button><button type="button" className="ks-link" disabled={busy} onClick={() => setConfirm(true)}>{t('Remove')}</button></div></div>
    {provider ? <div className="ks-row"><div className="ks-l"><b>{t("Sign-in")}</b></div><div className="ks-c"><button type="button" className="ks-link" aria-expanded={signIn} aria-controls={signInId} onClick={() => setSignIn(open => !open)}>{signIn ? t("Close") : t("Open")}</button></div></div> : null}
    {provider && signIn ? <div className="ka-sub settings-source__fold" id={signInId}><Credentials provider={provider} /></div> : null}
    <div className="ks-row"><div className="ks-l"><b>{t("Order")}</b></div><div className="ks-c"><button type="button" className="ks-link" onClick={() => openSettings('sources-audio')}>{t("Order of audio sources")}</button></div></div>
    {confirm ? <Modal title={t('Remove {{name}}', { name: extension.name })} onClose={() => { if (!busy) setConfirm(false) }}><div className="settings-modal__do"><button type="button" className="ks-btn ks-btn--ghost" disabled={busy} onClick={() => setConfirm(false)}>{t('Cancel')}</button><button type="button" className="ks-btn ks-btn--danger" disabled={busy} onClick={() => void remove()}>{t('Remove')}</button></div></Modal> : null}
  </AddonCard>
}

/** The host's complemento contract is unchanged; feature cards live here. */
export function Plugins({ target }: { target?: string } = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { admin } = useSettings()
  const location = usePluginInstaller()
  const heldLocation = useHeld(location)
  const [progressId, setProgressId] = useState<string>()
  const extensions = useExtensions(admin === true)
  const known = useKnownSources(!target && admin === true)
  const unlinked = extensions.data?.extensions.filter(item => item.kind === 'feature' && !pluginAddons.some(card => card.id === item.id) && (!target || item.id === target)) ?? []
  const selected = target && pluginAddons.find(card => card.id === target || card.open.id === target || (target === 'ties' && card.id === 'lineage'))
  const id = target === 'ties' || target === 'recommendations' ? target : 'plugins'
  return <Page id={id}>
    {!target && admin === true ? <div className="settings-block ks-group">{known.data?.sources.filter(source => !source.installed).map(source => <KnownSourceRow key={source.id} source={source} />)}<div className="ks-row"><div className="ks-l"><b>{t('Add a plugin')}</b></div><div className="ks-c"><button type="button" className="ks-link" onClick={() => { setProgressId(undefined); openPluginInstaller() }}>{t('Add')}</button></div></div>
    </div> : null}
    {admin === true ? extensions.data?.extensions.filter(item => item.kind === 'source' && (!target || item.id === target)).map(extension => <InstalledSource key={extension.id} extension={extension} onUpdate={(id, value) => { closePluginInstaller(); setProgressId(id); openPluginInstaller(value) }} />) : null}
    {heldLocation !== null && !target && admin === true ? <SourceInstaller key={progressId ?? heldLocation} open={location !== null} initialLocation={heldLocation} progressId={progressId} /> : null}
    {(!target || target === 'ties') && !pluginAddons.some(card => card.id === 'ties' || card.id === 'lineage') ? <AddonCard name={t('Ties')} kind={t('Coming soon')} icon={GitFork} /> : null}
    {(!target || target === 'recommendations') && !pluginAddons.some(card => card.id === 'recommendations') ? <AddonCard name={t('Recommendations')} kind={t('Coming soon')} icon={Sparkles} /> : null}
    {(selected ? [selected] : target ? [] : pluginAddons).map(card => <PluginAddon key={card.id} card={card} />)}
    {unlinked.map(extension => <AddonCard key={extension.id} name={extension.name} kind={t('Extension')} icon={Puzzle}>
      <AddonRow label={t('In the nest')} value={extension.name} state={null} extension={extension} />
    </AddonCard>)}
  </Page>
}

export function Ties(): React.JSX.Element { return <Plugins target="ties" /> }
export function Recommendations(): React.JSX.Element { return <Plugins target="recommendations" /> }
