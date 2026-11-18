import { useTranslation } from 'react-i18next'
import { openExternal } from '../../ui/components/cardArt'
import { Missing } from '../../ui/react/components/Missing'
import { Word } from '../parts'
import { computerState, type Computer } from './data'

export function ComputerStatus({ computer }: { computer: Computer }) {
  const { t } = useTranslation()
  const tooOld = computer.versionState === 'too-old'
  const title = tooOld ? t("Needs {{minimum}} or newer · not taking work", { minimum: computer.minimumVersion })
    : computer.lastSeenAt ? new Date(computer.lastSeenAt * 1000).toLocaleString() : undefined
  return <Word tone={tooOld || computer.pausedReason === 'thermal' ? 'bad' : computer.state === 'working' ? 'ok' : 'off'} title={title}>{t(computerState(computer))}</Word>
}

export function ComputerVersion({ computer }: { computer: Computer }) {
  const { t } = useTranslation()
  const update = computer.versionState === 'update' || computer.versionState === 'too-old'
  return <span className="bw-version"><code className="z-mono">{computer.version || <Missing kind="nodata" />}</code>{update ? <button type="button" className="ks-link bw-update" title={[computer.versionState === 'update' ? t("A newer helper is available; this one keeps working") : null, t(computer.nest ? "Update Flipspin on the nest to update the engine." : "Update Flipspin on that computer to update the engine.")].filter(Boolean).join(' · ')} onClick={() => openExternal('https://github.com/flipspin/flipspin/releases/latest')}>{t("Update Flipspin")}</button> : null}</span>
}
