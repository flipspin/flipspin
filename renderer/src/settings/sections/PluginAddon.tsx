import { Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { pluginPages, pluginSettingsSections } from '../../plugins'
import type { PluginAddon as Card, PluginAddonRow } from '../../plugins/types'
import { useSettings } from '../context'
import { Skel, Word } from '../parts'
import { AddonCard, AddonRow } from './AddonCard'
import { useExtensions } from '../data'
import { Missing } from '../../ui/react/components/Missing'

export function PluginAddon({ card }: { card: Card }): React.JSX.Element {
  return card.useRows ? <LivePluginAddon card={card} useRows={card.useRows} /> : <PluginAddonView card={card} />
}

function LivePluginAddon({ card, useRows }: { card: Card; useRows: NonNullable<Card['useRows']> }): React.JSX.Element {
  const { admin } = useSettings()
  const rows = useRows(admin === true)
  return <PluginAddonView card={{ ...card, ...rows }} />
}

function PluginAddonView({ card }: { card: Card }): React.JSX.Element {
  const { t } = useTranslation()
  const { admin, host } = useSettings()
  const extensions = useExtensions(admin === true)
  const extension = extensions.data?.extensions.find(item => item.kind === 'feature' && item.id === card.id)
  const [open, setOpen] = useState(false)
  const section = card.open.kind === 'settings' ? pluginSettingsSections.find(section => section.id === card.open.id) : undefined
  const page = pluginPages.find(page => page.id === (section?.id ?? card.open.id))
  const Settings = section?.Component
  // Preserve the old owner-only settings boundary, including while role loads.
  const allowed = admin === true
  const state = (row: PluginAddonRow) => <Word tone={allowed ? row.state.tone : 'off'} title={allowed ? row.state.title && t(row.state.title) : t("Admins only")}>{allowed ? t(row.state.label) : t("Unavailable")}</Word>
  return <AddonCard name={t(card.name)} kind={t("Extension")} icon={card.icon} description={card.description && t(card.description)}
    disabled={!allowed || (card.open.kind === 'settings' ? !Settings : !page || !host.openPage)}
    disabledTitle={!allowed ? t("Admins only") : undefined}
    expanded={Settings && allowed ? open : undefined}
    onOpen={() => { if (Settings) setOpen(value => !value); else host.openPage?.(card.open.id) }}>
    <AddonRow extension={extension} label={t("In the nest")} value={allowed ? t(card.nido.value, card.nido.values ?? {}) : <Missing kind="noAccess" />} state={state(card.nido)} />
    <AddonRow label={t("On this computer_device")} value={allowed ? t(card.computer.value, card.computer.values ?? {}) : <Missing kind="noAccess" />} state={state(card.computer)} mono actions={allowed ? <>
      {card.computer.install ? <button type="button" className="ks-btn" disabled={card.computer.install.disabled} title={card.computer.install.title && t(card.computer.install.title)} onClick={card.computer.install.run}>{t("Install")}</button> : null}
      {card.computer.remove ? <button type="button" className="ks-link" disabled={card.computer.remove.disabled} title={card.computer.remove.title && t(card.computer.remove.title)} onClick={card.computer.remove.run}>{t("Remove")}</button> : null}
    </> : null} />
    {open && Settings && allowed ? <div>
      {page && host.openPage ? <button className="ks-link" type="button" onClick={() => host.openPage?.(page.id)}>{t("Go")}</button> : null}
      <Suspense fallback={<Skel rows={3} />}><Settings /></Suspense>
    </div> : null}
  </AddonCard>
}
