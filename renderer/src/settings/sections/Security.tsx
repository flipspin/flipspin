import { useTranslation } from 'react-i18next'
import { SECURITY_KEYS } from '../config'
import { ConfigSection, SettingRow } from './ConfigSection'
import { NestKey } from './NestKey'

export function Security(): React.JSX.Element {
  const { t } = useTranslation()
  return <ConfigSection id="security" before={<NestKey />}>{config => <div className="settings-block ks-group">
    <div className="settings-block__head"><h3>{t('Security')}</h3></div>
    <div className="settings-block__body">{SECURITY_KEYS.flatMap(key => {
      const row = config.groups.flatMap(group => group.settings).find(row => row.key === key)
      return row ? [<SettingRow key={key} row={row} />] : []
    })}</div>
  </div>}</ConfigSection>
}
