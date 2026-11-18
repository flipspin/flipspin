import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AudioLines, Cpu, Layers, MicVocal, Monitor, Server } from 'lucide-react'
import { useSettings } from '../context'
import { Page } from '../sections/Head'
import { QueryFailure, Skel, Word } from '../parts'
import { helperSpeed } from '../helper'
import { Missing } from '../../ui/react/components/Missing'
import { useCompute, useComputeActions, kindNames, computerState, hours, oldest, reasons, type Computer, type Kind } from './data'
import { Pace, Placement, Sheet } from './controls'
import { ComputerSheet } from './ComputerSheet'
import { ComputerVersion, ComputerStatus } from './ComputerVersion'
import './background-work.css'

export function BackgroundWork() {
  const { t } = useTranslation()
  const { admin, go } = useSettings()
  const query = useCompute(admin === true)
  const actions = useComputeActions()
  const [computerId, setComputerId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const data = query.data
  const selectedComputer = data?.computers.find(c => c.id === computerId)
  const working = data?.computers.filter(c => c.state === 'working').length ?? 0
  if (admin !== true) return <Missing kind="noAccess" />
  return <Page id="equipos" action={data ? <button className="ks-btn" type="button" disabled={actions.busy} onClick={() => void actions.pause(!data.paused)}>{t(data.paused ? "Resume all" : "Pause all")}</button> : undefined} sub={data ? t("{{n}} waiting · {{computers}} working", { n: data.waiting, computers: working }) : undefined}>
    {query.isError ? <QueryFailure error={query.error} what={t("background work")} onRetry={() => void query.refetch()} /> : !data ? <Skel rows={6} /> : <>

      <section className="bw-panel ks-group" aria-label={t("Computers")}><h3>{t("Computers")} <small>{data.computers.length}</small></h3>
        <div className="bw-computers bw-columns" aria-hidden><span>{t("Computer_computer")}</span><span>{t("Can do · speed")}</span><span>{t("Hours")}</span><span>{t("Pace")}</span><span /></div>
        {data.computers.map(computer => <div className="bw-computers bw-row" key={computer.id}>
          <button type="button" className="bw-name" aria-label={`${computer.nest ? t("The nest") : computer.name} · ${t(computerState(computer))}`} onClick={() => setComputerId(computer.id)}><span className="bw-icon">{computer.nest ? <Server className="i" aria-hidden /> : <Monitor className="i" aria-hidden />}</span><span><b>{computer.nest ? t("The nest") : computer.name}</b><ComputerStatus computer={computer} /></span></button>
          <span className="bw-speeds"><ComputerVersion computer={computer} /><Speeds computer={computer} />{computer.nest ? <small>{computer.limits.cpuPercent / 100} {t("cores")} · {computer.limits.maxTempC} °C {t("stop")}</small> : null}</span>
          <span className="z-mono">{computer.nest ? null : !computer.limits.window ? t("Any time") : hours(computer.limits)}</span>
          <Pace value={computer.limits.pace} label={t("{{name}} pace", { name: computer.name })} disabled={actions.busy} onChange={pace => void actions.computer(computer, { pace })} />
          <button className="ks-btn ks-btn--sm" type="button" disabled={actions.busy} onClick={() => void actions.computer(computer, { paused: !computer.limits.paused })}>{t(computer.limits.paused ? "Resume" : "Pause")}</button>
        </div>)}
        <footer className="bw-footer"><button className="ks-link" type="button" onClick={() => setAdding(true)}>{t("Add a computer")}</button></footer>
      </section>
      <section className="bw-panel ks-group" aria-label={t("Where work runs")}><h3>{t("Where work runs")} <small>{t("{{n}} waiting", { n: data.waiting })}</small></h3>
        <div className="bw-work bw-columns" aria-hidden><span>{t("Kind")}</span><span>{t("Waiting_pending")}</span><span>{t("Now")}</span><span>{t("May run on")}</span><span /></div>
        {data.kinds.map(kind => {
          const Icon = kind.kind === 'align' ? MicVocal : kind.kind === 'stems' ? Layers : AudioLines
          // No computer has an engine for this kind: its queue is kept for when one appears, but it isn't a backlog.
          // A more specific server reason (e.g. it needs a helper computer) keeps its own words.
          const setUp = data.computers.some(computer => computer.jobs.includes(kind.kind)) || (kind.reason != null && kind.reason !== 'no-engine')
          return <div className="bw-work bw-row" key={kind.kind}>
            <button type="button" className="bw-name" aria-label={t(kindNames[kind.kind])} onClick={() => go(kind.kind === 'align' ? 'letras' : kind.kind === 'stems' ? 'stems' : 'analisis')}><span className={`bw-icon bw-icon--${kind.kind}`}><Icon className="i" aria-hidden /></span><span><b>{t(kindNames[kind.kind])}</b></span></button>
            {setUp ? <span className="bw-count">{kind.waiting}{kind.oldestAt != null ? <small title={new Date(kind.oldestAt * 1000).toLocaleString()}>{t("oldest {{age}}", { age: oldest(kind.oldestAt) })}</small> : null}</span>
              : <span className="bw-count bw-count--idle" title={kind.waiting ? t("{{n}} songs will be processed once an engine is installed", { count: kind.waiting, n: kind.waiting }) : undefined}>{kind.waiting}</span>}
            {setUp ? <KindState kind={kind} computers={data.computers} paused={data.paused} />
              : <span><Word tone="off">{t("Not set up")}</Word> <button type="button" className="ks-link" onClick={() => go('complementos')}>{t("Install")}</button></span>}
            <Placement kind={kind} disabled={actions.busy} onChange={placement => void actions.kind(kind.kind, { placement })} />
            <button className="ks-btn ks-btn--sm" type="button" disabled={actions.busy} onClick={() => void actions.kind(kind.kind, { paused: !kind.policy.paused })}>{t(kind.policy.paused ? "Resume" : "Pause")}</button>
          </div>
        })}
      </section>
    </>}
    <Sheet open={!!selectedComputer} title={selectedComputer?.nest ? t("The nest") : selectedComputer?.name ?? t("Computer_computer")} onClose={() => setComputerId(null)}>{selectedComputer ? <ComputerSheet computer={selectedComputer} /> : null}</Sheet>
    <Sheet open={adding} title={t("Add a computer")} onClose={() => setAdding(false)}><ol className="bw-add-steps"><li>{t("Install Flipspin on that computer")}</li><li>{t("Sign in with an admin account")}</li><li>{t("Settings → Engines → Install")}</li></ol><Word>{t("Waiting for a computer")}</Word></Sheet>
  </Page>
}
function KindState({ kind, computers, paused }: { kind: Kind; computers: Computer[]; paused: boolean }) {
  const { t } = useTranslation()
  if (paused || kind.policy.paused) return <Word>{t("Paused")}</Word>
  if (kind.running.length) return <Word tone="ok">{Array.from(new Set(kind.running.map(r => computers.find(c => c.id === r.workerId)?.name ?? t("Helper_computer")))).join(' · ')} · {kind.running[0].title}</Word>
  if (!kind.waiting) return <span><Word tone={kind.failed ? 'bad' : 'ok'}>{t(kind.failed ? "Couldn't process" : "Up to date_current")}</Word>{kind.failed ? ` · ${kind.failed}` : null}</span>
  return <Word tone={kind.reason === 'thermal' ? 'bad' : 'warn'}>{kind.reason === 'helpers-offline' && kind.waitingFor ? t("Waiting for {{name}}", { name: kind.waitingFor }) : t(reasons[kind.reason ?? 'helpers-busy'] ?? "Waiting for a computer")}</Word>
}
function Speeds({ computer }: { computer: Computer }) {
  const { t } = useTranslation()
  if (!computer.jobs.length) return <Missing kind="nodata" reason={t("No engine installed")} />
  return <>{computer.jobs.filter(k => k !== 'transcribe').map(kind => {
    const speed = helperSpeed(computer, kind)
    return <span key={kind} title={t("Measured on this computer")}>{t(kindNames[kind] ?? kind)}{speed.value != null ? ` · ${speed.value.toFixed(1)} s/min` : ''}</span>
  })}</>
}
