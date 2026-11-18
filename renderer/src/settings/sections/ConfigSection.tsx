import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu, Download, FileText, Lock, Power } from 'lucide-react'
import { CAPACITY_KEYS, capacityPresets, useConfig, type Setting, type ServerConfig } from '../config'
import { CHOICES, CONFIG_DISABLED_REASONS, CONFIG_LABELS, CONFIG_TIPS, PRESETS } from '../configWords'
import { CopyButton, Dot, Modal, QueryFailure, Seg, Skel, Switch, Tipped, Word } from '../parts'
import { Page } from './Head'
import { missingWord } from '../../ui/react/components/missingWords'
import { sectionOf } from '../sections'

function display(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(' · ') : value === null || value === undefined ? missingWord('notSet') : String(value)
}
function Source({ row }: { row: Setting }): React.JSX.Element {
  const { t } = useTranslation()
  const { query } = useConfig()
  // The API identifies the source, not the actual EnvironmentFile path.
  const file = query.data?.machine.container ? t("container variable") : t("nest file")
  return <span className={`settings-srcw${row.source === 'env' ? ' settings-srcw--env' : ''}`} title={row.source === 'env' ? `${file} · ${row.key}` : row.key}>
    {!row.editable || row.source === 'env' ? <Lock className="i" aria-hidden /> : null}
    {t(row.source === 'env' ? "from the nest" : row.source === 'app' ? "changed here" : "default")}
  </span>
}
function Value({ row, value }: { row: Setting; value: unknown }): React.JSX.Element {
  const { t } = useTranslation()
  if (row.secret) return <Word tone={row.configured ? 'ok' : 'off'}>{!row.configured ? <Dot tone="off" /> : null}{t(row.configured ? "configured" : "not set")}</Word>
  if (row.kind === 'bool') return <>{t(value === true ? "yes" : 'no')}</>
  if (row.key === 'KROBI_CORS_ORIGINS' && Array.isArray(value)) return <span title={display(value)}>{t("{{n}} pages", { count: value.length, n: value.length })}</span>
  return <span className={row.kind === 'path' ? 'z-mono settings-cfg__path' : undefined} title={row.kind === 'path' ? display(value) : undefined}>{t(CHOICES[display(value)] ?? display(value))}</span>
}
export function SettingRow({ row }: { row: Setting }): React.JSX.Element {
  const { t } = useTranslation()
  const { query, save, saving, errors, restarting } = useConfig()
  const label = t(CONFIG_LABELS[row.key] ?? row.key)
  const pending = query.data.restart.pending.includes(row.key)
  const disabledMessage = CONFIG_DISABLED_REASONS[row.disabledReason ?? ''] ?? row.disabledMessage
  const detail = [CONFIG_TIPS[row.key] ? t(CONFIG_TIPS[row.key]) : null, disabledMessage ? t(disabledMessage) : null, pending && !row.secret ? `${t(CHOICES[display(row.value)] ?? display(row.value))} → ${t(CHOICES[display(row.pendingValue)] ?? display(row.pendingValue))} · ${t("on restart")}` : null, errors[row.key], row.key === 'KROBI_FFMPEG_PATH' ? [t("ffmpeg version"), row.version, t("ffmpeg source"), row.binarySource ? t(row.binarySource === 'env' ? "Configured path" : row.binarySource === 'system' ? "System" : "Bundled with Flipspin") : null].filter(Boolean).join(' · ') : null].filter(Boolean).join(' · ')
  const value = pending ? row.pendingValue : row.value
  const editable = row.editable && row.source !== 'env' && !row.secret
  const disabled = saving || restarting || (Boolean(row.disabledReason) && value !== true)
  return <><div className={`settings-cfg${!editable ? ' is-locked' : ''}`} data-config-key={row.key}>
    <span className="settings-cfg__k">
      <Tipped tip={detail}>{label}</Tipped>
      {row.needsRestart ? <span className="settings-restartmark" title={t("Applies when the nest restarts")}><Power className="i" aria-hidden /></span> : null}
    </span>
    <span className="settings-cfg__v">
      {editable && row.kind === 'bool' ? <Switch label={label} checked={value === true} disabled={disabled} onChange={(v) => void save({ [row.key]: v })} /> :
        editable && row.kind === 'choice' ? <select className="ks-sel ks-sel--sm" aria-label={label} value={display(value)} disabled={disabled} onChange={(e) => void save({ [row.key]: e.target.value })}>
          {row.choices?.map((v) => <option key={v} value={v}>{t(CHOICES[v] ?? v)}</option>)}
        </select> : editable ? <input className="ks-field" aria-label={label} type={row.kind === 'int' ? 'number' : 'text'} min={row.min ?? undefined} max={row.max ?? undefined} defaultValue={display(value)} key={display(value)} disabled={disabled} onBlur={(e) => { const next = row.kind === 'int' ? Number(e.target.value) : e.target.value; if (next !== value) void save({ [row.key]: next }) }} /> : <Value row={row} value={row.value} />}
      {row.key === 'KROBI_ALLOW_UNAUTHENTICATED_REMOTE' && row.value === true ? <Word tone="warn">{t("Access without an account from the network")}</Word> : null}
    </span>
    <Source row={row} />
  </div></>

}

export function Capacity({ config, rows }: { config: ServerConfig; rows: Setting[] }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { save, saving, errors, restarting } = useConfig()
  const [custom, setCustom] = useState(false)
  const [draft, setDraft] = useState<Record<string, number>>({})
  async function commit(row: Setting) {
    const next = draft[row.key]
    if (next === undefined || next === row.value) return
    await save({ [row.key]: next })
    setDraft((current) => { const rest = { ...current }; delete rest[row.key]; return rest })
  }
  const ordered = CAPACITY_KEYS.map((key) => rows.find((row) => row.key === key))
  const machine = config.machine
  const presets = capacityPresets(config)
  const gb = (n: number) => `${(n / 1e9).toLocaleString(i18n.language, { maximumFractionDigits: 1 })} GB`
  const Icons = [Download, FileText]
  return <div className="settings-block ks-group settings-cap">
    <div className="settings-block__head"><h3>{t("Performance")}</h3><span className="settings-machine settings-head-act" title={[t("What the nest can use, including its container limits"), machine.arch, t("Catalogs set the pace (LRCLIB answers once per second), rather than the machine."), t("Lyrics from catalogs"), t("one at a time"), t("Stems and lyrics sync run on another computer in your home."), t("Stems and lyrics sync")].join(' · ')}><Cpu className="i" aria-hidden /><span>{t("{{n}} cores", { count: machine.cores, n: machine.cores })} · {gb(machine.memoryBytes)}</span></span></div>
    <div className="settings-block__body">
      <div className="settings-presets" role="radiogroup" aria-label={t("Profile")}>
        {Object.entries(PRESETS).map(([id, label]) => {
          const values = CAPACITY_KEYS.map(key => presets[id][key])
          return <button key={id} className="settings-preset" type="button" role="radio" aria-checked={!custom && ordered.every((row, i) => row?.value === values[i])} disabled={saving || restarting || ordered.some((r) => !r?.editable || r.source === 'env')} onClick={() => { setCustom(false); void save(Object.fromEntries(CAPACITY_KEYS.map((key, i) => [key, values[i]]))) }}>
            <b>{t(label)}</b><span className="settings-preset__n">{values.map((v, i) => { const Icon = Icons[i]; return <span key={i} title={t(CONFIG_LABELS[CAPACITY_KEYS[i]])}><Icon className="i" aria-hidden /><span className="z-mono">{v}</span></span> })}</span>
            {id === 'normal' ? <span className="settings-preset__tag">{t("suggested")}</span> : null}
          </button>
        })}
        <button className="settings-preset" type="button" role="radio" aria-checked={custom || !Object.values(presets).some(values => ordered.every(r => r?.value === values[r?.key]))} onClick={() => setCustom(true)}><b>{t("Custom")}</b><span className="settings-preset__n">{ordered.map((r) => display(draft[r?.key] ?? r?.value)).join(' · ')}</span></button>
      </div>
      {ordered.filter((r): r is Setting => !!r).map((row) => {
        const value = draft[row.key] ?? Number(row.value)
        const maximum = row.key === CAPACITY_KEYS[0] ? 4 : row.max
        const suggested = row.key === CAPACITY_KEYS[0] ? 2 : row.suggestedMax
        const over = suggested != null && value > suggested
        return <div key={row.key} className={`settings-capr${over ? ' is-over' : ''}`} data-config-key={row.key} style={{ '--_pct': maximum === row.min ? 1 : (value - Number(row.min)) / (Number(maximum) - Number(row.min)), '--_sug': maximum === row.min ? 1 : (Number(suggested) - Number(row.min)) / (Number(maximum) - Number(row.min)) } as React.CSSProperties}>
          <span className="settings-capr__k"><Tipped tip={[t(CONFIG_TIPS[row.key]), over ? t("more than recommended for this computer") : t("The next task to start already follows it"), t(row.source === 'env' ? "from the nest" : row.source === 'app' ? "changed here" : "default"), errors[row.key]].filter(Boolean).join(' · ')}>{t(CONFIG_LABELS[row.key])}</Tipped></span>
          <label className="z-slider settings-capr__s" title={t("Recommended: {{min}}–{{max}}", { min: row.min, max: suggested })}><input type="range" aria-label={t(CONFIG_LABELS[row.key])} min={row.min} max={maximum} value={value} disabled={!row.editable || row.source === 'env' || saving || restarting} onChange={(e) => { setCustom(true); setDraft({ ...draft, [row.key]: Number(e.target.value) }) }} onPointerUp={() => void commit(row)} onKeyUp={() => void commit(row)} onBlur={() => void commit(row)} /><output className="z-slider__value">{value}</output></label>

        </div>
      })}
      {rows.filter((r) => !(CAPACITY_KEYS as readonly string[]).includes(r.key)).map((row) => <SettingRow key={row.key} row={row} />)}

    </div>
  </div>
}

function RestartDialog({ config, close }: { config: ServerConfig; close: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { restart, restartError } = useConfig()
  const [when, setWhen] = useState<'idle' | 'now'>('idle')
  const [busy, setBusy] = useState(false)
  const a = config.activity
  return <Modal className="settings-config-restart-dialog" title={t("Restart the nest?")} onClose={() => { if (!busy) close() }}>
    <ul className="settings-impact">
      <li><Dot tone="ok" /><span>{t("What happens:")} <b>{config.restart.pending.map((key) => { const row = config.groups.flatMap((g) => g.settings).find((r) => r.key === key); return <span key={key}>{t(CONFIG_LABELS[key] ?? key)}{row && !row.secret ? <> → <Value row={row} value={row.pendingValue} /></> : null}</span> })}</b></span></li>
      <li><Dot tone={when === 'now' ? 'warn' : 'none'} /><span>{when === 'idle' ? t("Waits for {{n}} active downloads", { count: a.downloads, n: a.downloads }) : t("{{n}} active downloads will be interrupted", { count: a.downloads, n: a.downloads })}</span></li>
      <li><Dot /><span>{when === 'idle' ? t("Waits for {{n}} active jobs", { count: a.jobs, n: a.jobs }) : t("{{n}} active jobs will be interrupted", { count: a.jobs, n: a.jobs })}</span></li>
      <li><Dot /><span>{t("{{n}} connected devices reconnect automatically in a few seconds", { count: a.devicesSeen5min, n: a.devicesSeen5min })}</span></li>
      <li><Dot /><span>{t("The current song keeps playing")}</span></li>
    </ul>
    {config.restart.supported ? <div className="z-field"><span className="z-label">{t("When")}</span><Seg label={t("When")} value={when} onChange={(v) => { if (!busy) setWhen(v) }} options={[{ value: 'idle', label: t("After downloads finish"), title: t("Wait until no downloads or imports remain") }, { value: 'now', label: t("Now") }]} /></div> : <>
      {config.restart.command ? <div className="settings-cmd"><code className="z-mono">{config.restart.command}</code><CopyButton value={config.restart.command} /></div> : null}
      <Word title={t("Flipspin found neither systemd nor Docker to bring it back up")}>{t("restart it from the nest’s computer")}</Word>
    </>}
    {restartError ? <span className="settings-cfg__err" role="alert">{restartError}</span> : null}
    <div className="settings-modal__do"><button className="ks-btn" type="button" disabled={busy} onClick={close}>{t("Cancel")}</button>{config.restart.supported ? <button className="ks-btn ks-btn--go" type="button" disabled={busy} onClick={() => { setBusy(true); void restart(when).then((ok) => { setBusy(false); if (ok) close() }) }}>{t(when === 'idle' ? "Restart when finished" : "Restart now")}</button> : null}</div>
  </Modal>
}

/** Shared loading, restart status and restart dialog for nest configuration pages. */
export function ConfigSection({ id, before, children }: {
  id: 'performance' | 'network' | 'security'
  before?: ReactNode
  children?: (config: ServerConfig) => ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const { query, restarting, slow } = useConfig()
  const [dialog, setDialog] = useState(false)
  const config = query.data
  const count = config?.restart.pending.length ?? 0
  return <Page id={id}>
    {before}
    {!config ? <div className="settings-block ks-group">{query.isPending ? <><div className="settings-block__head"><h3>{t(sectionOf(id).label)}</h3><span>…</span></div><Skel rows={5} /><Skel rows={3} /></> : <QueryFailure error={query.error} what={t("the configuration")} older={t("Update the nest to see this section.")} onRetry={() => void query.refetch()} />}</div> : <>
      {restarting ? <div className="settings-restart settings-restart--busy" role="status"><Dot /><span className="settings-restart__what"><b>{t("Restarting the nest…")}</b><span className="settings-restart__keys">{slow ? t("if it does not return, start it from the nest’s computer") : t("Looking for your nest…")}</span></span></div> : count > 0 ? <div className="settings-restart"><Dot tone="warn" /><span className="settings-restart__what"><b>{t("Restart the nest to apply {{n}} changes", { count, n: count })}</b><span className="settings-restart__keys">{config.groups.flatMap((g) => g.settings).filter((r) => config.restart.pending.includes(r.key) && !r.secret).map((r) => <span key={r.key}>{t(CONFIG_LABELS[r.key] ?? r.key)}: <s><Value row={r} value={r.value} /></s> → <Value row={r} value={r.pendingValue} /></span>)}</span></span><button className="ks-btn ks-btn--sm ks-btn--go" type="button" onClick={() => setDialog(true)}><Power className="i" aria-hidden />{t("Restart…")}</button></div> : null}
      {children?.(config)}
      {dialog ? <RestartDialog config={config} close={() => setDialog(false)} /> : null}
    </>}
  </Page>
}
