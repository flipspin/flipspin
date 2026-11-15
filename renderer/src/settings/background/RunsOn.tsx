import { useTranslation } from 'react-i18next'
import { Missing } from '../../ui/react/components/Missing'
import { useSettings } from '../context'
import { placements, useCompute, type Kind } from './data'

/** Placement is edited only in Helpers; feature pages show the current answer. */
export function RunsOn({ kind: id }: { kind: Kind['kind'] }) {
  const { t } = useTranslation()
  const { admin, go } = useSettings()
  const query = useCompute(admin === true)
  const kind = query.data?.kinds.find(item => item.kind === id)
  const workerIds = new Set(kind?.running.map(job => job.workerId))
  const names = query.data?.computers.filter(computer => workerIds.has(computer.id)).map(computer => computer.name) ?? []
  const helper = !names.length && kind?.waitingFor ? kind.waitingFor : names.join(' · ')
  return <div className="ks-row"><span className="ks-l"><b>{t("Runs on")}</b><span>{kind ? <>{t(placements[kind.policy.placement])}{helper ? ` · ${helper}` : ''}</> : <Missing kind={query.isError ? 'nodata' : 'loading'} />}</span></span><button className="ks-link" type="button" onClick={() => go('equipos')}>{t("Helpers_helpers")}</button></div>
}
