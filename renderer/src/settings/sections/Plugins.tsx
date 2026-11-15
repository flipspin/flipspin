import { useHeld } from '../../ui/react/useHeld'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiPost, queryKeys, isApiError } from '../../data'
import { Modal, useToast } from '../parts'
import { Missing } from '../../ui/react/components/Missing'
import { ExtensionState, type Extension } from '../extensions'
import { openPluginInstaller, closePluginInstaller, usePluginInstaller } from '../sourceInstaller'
import { SourceInstaller } from './SourceInstaller'
import { useTranslation } from 'react-i18next'
import { GitFork, Puzzle, Sparkles } from 'lucide-react'
import { pluginAddons } from '../../plugins'
import { Page } from './Head'
import { AddonCard, AddonRow } from './AddonCard'
import { PluginAddon } from './PluginAddon'
import { useExtensions } from '../data'
import { useSettings } from '../context'

function InstalledSource({ extension, onUpdate }: { extension: Extension; onUpdate: (id: string, location: string) => void }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
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
  return <>
    <div className="ks-row"><div className="ks-l"><b>{extension.name}</b></div><div className="ks-c"><code>{extension.version ?? <Missing kind="nodata" />}</code><ExtensionState extension={extension} /><button type="button" className="ks-link" disabled={busy} onClick={() => void update()}>{t('Update')}</button><button type="button" className="ks-link" disabled={busy} onClick={() => setConfirm(true)}>{t('Remove')}</button></div></div>
    {confirm ? <Modal title={t('Remove {{name}}', { name: extension.name })} onClose={() => { if (!busy) setConfirm(false) }}><div className="settings-modal__do"><button type="button" className="ks-btn ks-btn--ghost" disabled={busy} onClick={() => setConfirm(false)}>{t('Cancel')}</button><button type="button" className="ks-btn ks-btn--danger" disabled={busy} onClick={() => void remove()}>{t('Remove')}</button></div></Modal> : null}
  </>
}

/** The host's complemento contract is unchanged; feature cards live here. */
export function Plugins({ target }: { target?: string } = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { admin } = useSettings()
  const location = usePluginInstaller()
  const heldLocation = useHeld(location)
  const [progressId, setProgressId] = useState<string>()
  const extensions = useExtensions(admin === true)
  const unlinked = extensions.data?.extensions.filter(item => item.kind === 'feature' && !pluginAddons.some(card => card.id === item.id) && (!target || item.id === target)) ?? []
  const selected = target && pluginAddons.find(card => card.id === target || card.open.id === target || (target === 'ties' && card.id === 'lineage'))
  const id = target === 'ties' || target === 'recommendations' ? target : 'plugins'
  return <Page id={id}>
    {!target && admin === true ? <div className="settings-block ks-group"><div className="ks-row"><div className="ks-l"><b>{t('Add a plugin')}</b></div><div className="ks-c"><button type="button" className="ks-link" onClick={() => { setProgressId(undefined); openPluginInstaller() }}>{t('Add')}</button></div></div>
      {extensions.data?.extensions.filter(item => item.kind === 'source').map(extension => <InstalledSource key={extension.id} extension={extension} onUpdate={(id, value) => { closePluginInstaller(); setProgressId(id); openPluginInstaller(value) }} />)}
    </div> : null}
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
