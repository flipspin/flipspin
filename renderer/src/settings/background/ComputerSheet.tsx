import { Missing } from '../../ui/react/components/Missing'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../config'
import { Switch } from '../parts'
import { Pace } from './controls'
import { ComputerVersion, ComputerStatus } from './ComputerVersion'
import { hours, useComputeActions, kindNames, type Computer, type Limits } from './data'

export function ComputerSheet({ computer }: { computer: Computer }) {
  const { t } = useTranslation()
  const actions = useComputeActions()
  const { query: config } = useConfig()
  const pinned = (keys: string[]) => computer.nest && config.data?.groups.flatMap(g => g.settings).some(row => keys.includes(row.key) && row.source === 'env')
  const limits = computer.limits
  const [editing, setEditing] = useState(false)
  const [window, setWindow] = useState(limits.window ?? { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 60, endMinute: 420 })
  const save = (values: Partial<Limits>) => void actions.computer(computer, values)
  const time = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
  const minute = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
  return <>
    <span className="z-mono">{[computer.chip || computer.gpu, computer.os, computer.memoryBytes ? `${Math.round(computer.memoryBytes / 2 ** 30)} GB` : null].filter(Boolean).join(' · ')}</span>
    <ComputerVersion computer={computer} />
    <ComputerStatus computer={computer} />
    <div className="ks-row"><b>{t("Pace")}</b><Pace value={limits.pace} label={t("Pace")} disabled={actions.busy} onChange={pace => save({ pace })} /></div>
    {computer.nest ? <>
      <div className="ks-row"><b>CPU</b><select className="ks-sel" aria-label={t("CPU limit")} value={limits.cpuPercent} disabled={actions.busy || pinned(['KROBI_NEST_CPU_PERCENT'])} onChange={e => save({ cpuPercent: Number(e.target.value) })}>{[25, 50, 100].map(n => <option key={n} value={n}>{n / 100} {t("cores")}</option>)}</select></div>
      <div className="ks-row"><span className="ks-l"><b>{t("Stop when hot")}</b><span>{limits.maxTempC} °C · {t("resumes at")} {limits.resumeTempC} °C{computer.temperatureC != null ? ` · ${t("now")} ${computer.temperatureC.toFixed(0)} °C` : ''}</span></span></div>
      <div className="ks-row"><label>{t("Stop at")} <input className="ks-field bw-number" aria-label={t("Stop temperature")} disabled={pinned(['KROBI_NEST_MAX_TEMP_C'])} type="number" min={limits.resumeTempC + 1} max={100} defaultValue={limits.maxTempC} onBlur={e => { const maxTempC = Number(e.target.value); if (maxTempC >= 40 && maxTempC <= 100 && maxTempC > limits.resumeTempC) save({ maxTempC }) }} /></label><label>{t("Resume at")} <input className="ks-field bw-number" aria-label={t("Resume temperature")} disabled={pinned(['KROBI_NEST_RESUME_TEMP_C'])} type="number" min={30} max={limits.maxTempC - 1} defaultValue={limits.resumeTempC} onBlur={e => { const resumeTempC = Number(e.target.value); if (resumeTempC >= 30 && resumeTempC < limits.maxTempC) save({ resumeTempC }) }} /></label></div>
    </> : null}
    {!computer.nest ? <div className="ks-row"><span className="ks-l"><b>{t("Hours")}</b><span>{limits.window ? hours(limits) : t("Any time")}</span></span><button className="ks-btn" type="button" onClick={() => setEditing(!editing)}>{t("Change_schedule")}</button></div> : null}
    {!computer.nest && editing ? <fieldset className="bw-hours"><legend>{t("Hours")}</legend><div className="bw-days">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => <label key={day}><input type="checkbox" checked={window.days.includes(i)} onChange={e => setWindow({ ...window, days: e.target.checked ? [...window.days, i] : window.days.filter(d => d !== i) })} />{t(day)}</label>)}</div><div className="ks-row"><input type="time" aria-label={t("From")} value={time(window.startMinute)} onChange={e => setWindow({ ...window, startMinute: minute(e.target.value) })} /><input type="time" aria-label={t("Until")} value={time(window.endMinute)} onChange={e => setWindow({ ...window, endMinute: minute(e.target.value) })} /></div><div className="bw-footer"><button className="ks-link" type="button" disabled={actions.busy} onClick={() => { save({ window: null }); setEditing(false) }}>{t("Any time")}</button><button className="ks-btn" type="button" disabled={!window.days.length || actions.busy} onClick={() => { save({ window }); setEditing(false) }}>{t("Save")}</button></div></fieldset> : null}
    {!computer.nest && (computer.powerReadable || limits.onlyCharging) ? <div className="ks-row"><b>{t("Only when charging")}</b><Switch label={t("Only when charging")} checked={limits.onlyCharging} disabled={actions.busy} onChange={onlyCharging => save({ onlyCharging })} /></div> : null}
    <div className="ks-row"><b>{t("Can do")}</b><span>{computer.jobs.length ? computer.jobs.filter(kind => kind !== 'transcribe').map(kind => t(kindNames[kind] ?? kind)).join(' · ') : <Missing kind="nodata" />}</span></div>
  </>
}
