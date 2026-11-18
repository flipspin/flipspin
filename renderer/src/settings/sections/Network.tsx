import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CAPACITY_KEYS, SECURITY_KEYS, type Setting, type ServerConfig } from '../config'
import { GROUP_LABELS } from '../configWords'
import { Modal } from '../parts'
import { ConfigSection, SettingRow } from './ConfigSection'

function NetworkSettings({ config }: { config: ServerConfig }): React.JSX.Element {
  const { t } = useTranslation()
  const [secondary, setSecondary] = useState(false)
  const networkKeys = ['KROBI_BACKEND_PORT', 'KROBI_ADVERTISE', 'KROBI_UPDATE_CHECK']
  const rows = config.groups.flatMap(g => g.settings)
  return <>
    <div className="settings-block ks-group"><div className="settings-block__head"><h3>{t("Network")}</h3></div><div className="settings-block__body">{networkKeys.map(key => rows.find(r => r.key === key)).filter((r): r is Setting => !!r).map(row => <SettingRow key={row.key} row={row} />)}</div></div>
    <div className="settings-block ks-group"><div className="ks-row"><b title={t('Log detail, allowed web pages and proxy headers')}>{t('Advanced')}</b><button type="button" className="ks-link" aria-haspopup="dialog" onClick={() => setSecondary(true)}>{t('Open')}</button></div></div>
    {secondary ? <Modal title={t("Advanced")} onClose={() => setSecondary(false)} className="settings-modal--wide">{config.groups.map(group => {
      const extra = group.settings.filter(r => !['KROBI_NEST_PROCESSES', 'KROBI_LYRICS_ENGINE', 'KROBI_STEMS_BACKGROUND', 'KROBI_ANALYSIS_AUTO', 'KROBI_NEST_CPU_PERCENT', 'KROBI_NEST_MAX_TEMP_C', 'KROBI_NEST_RESUME_TEMP_C'].includes(r.key) && !networkKeys.includes(r.key) && !SECURITY_KEYS.includes(r.key) && !(CAPACITY_KEYS as readonly string[]).includes(r.key))
      return extra.length ? <div key={group.id}><h4>{t(GROUP_LABELS[group.id] ?? group.id)}</h4>{extra.map(row => <SettingRow key={row.key} row={row} />)}</div> : null
    })}</Modal> : null}
  </>
}

export function Network(): React.JSX.Element {
  return <ConfigSection id="network">{config => <NetworkSettings config={config} />}</ConfigSection>
}
