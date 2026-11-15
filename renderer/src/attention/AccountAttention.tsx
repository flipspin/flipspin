import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpCircle, Cpu } from 'lucide-react'
import { msg } from '../i18n'
import { openExternal } from '../ui/components/cardArt'
import { refreshMac, useMacEngine } from '../lyrics/macEngine'
import { formatAgo } from '../settings/format'
import type { Attention } from './useAttention'
import { attentionLabel } from './words'

const tones = { info: 'var(--teal)', warn: 'var(--yellow)', bad: 'var(--rose)' }
const states = {
  idle: { word: msg("Free"), color: 'var(--green)' },
  working: { word: msg("Working"), color: 'var(--teal)' },
  asleep: { word: msg("Asleep"), color: 'var(--yellow)' },
  closed: { word: msg("Closed"), color: 'var(--ink-3)' },
  offline: { word: msg("Offline"), color: 'var(--rose)' },
  outdated: { word: msg("Outdated"), color: 'var(--yellow)' },
  revoked: { word: msg("No access"), color: 'var(--ink-3)' },
}

export function AttentionDot({ value }: { value: Attention | undefined }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!value?.flag || !value.flagTone) return null
  const label = attentionLabel(value, t)
  return <span role="img" aria-label={label} className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-[var(--canvas)] shadow-[0_0_0_1.5px_var(--ink)]" style={{ background: tones[value.flagTone] }} />
}

const rowClass = 'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-control text-left text-[var(--ink)]'
const iconClass = 'grid place-items-center shrink-0 w-8 h-8 rounded-panel border-2 border-black bg-[var(--paper)]'
const actionClass = 'shrink-0 p-0 border-0 shadow-none bg-transparent text-[11px] font-semibold text-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-50'

export function AccountAttention({ value, go, retry, busy }: {
  value: Attention | undefined
  go: (section: string) => void
  retry: () => void
  busy: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const mac = useMacEngine()
  const helper = value?.helper
  useEffect(() => { if (value && helper === null) void refreshMac() }, [value, helper])
  const offerMac = value && helper === null && mac.status?.supported === true
  const version = value?.version
  if (!version?.show && !helper && !offerMac) return null
  const state = helper ? states[helper.state] : null
  let fact = helper?.version ?? ''
  if (helper?.state === 'asleep' || helper?.state === 'closed') fact = t("{{count}} waiting", { count: helper.waiting })
  if (helper?.state === 'offline' && helper.lastSeenAt != null) fact = formatAgo(helper.lastSeenAt * 1000)
  if (helper?.state === 'outdated' && helper.minimumVersion) fact = `${helper.version} → ${helper.minimumVersion}`
  if (helper?.state === 'working' && helper.progress) fact = `${helper.progress.done} / ${helper.progress.total}`
  return <div className="border-t-2 border-[var(--line-soft)] p-1.5">
    {version?.show ? <button type="button" role="menuitem" onClick={() => go('version')} className={`${rowClass} border-0 shadow-none bg-transparent hover:bg-[var(--paper)]`}>
      <span className={`${iconClass} bg-[var(--teal-tint)]`}><ArrowUpCircle size={16} aria-hidden /></span>
      <span className="min-w-0 flex-1 leading-tight"><b className="block text-[13.5px]">Flipspin {version.latest}</b>
        <span className="flex items-center gap-1 text-[11px] mt-1"><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--teal)]" />{t("New version")} <span className="font-mono text-[var(--ink-3)]">· {t("you have {{version}}", { version: version.current })}</span></span>
      </span><span className="text-[11px] text-[var(--ink-3)]">{t("View")} ›</span>
    </button> : null}
    {helper && state ? <div className={rowClass}>
      <span className={iconClass}><Cpu size={16} aria-hidden /></span>
      <span className="min-w-0 flex-1 leading-tight"><b className="block truncate text-[13.5px]">{helper.name}</b>
        <span className="flex items-center gap-1 text-[11px] mt-1 whitespace-nowrap"><span aria-hidden className="shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: state.color }} />{t(state.word)} <span className="font-mono text-[var(--ink-3)]">· {fact}</span></span>
      </span>
      {helper.state === 'offline' ? <button type="button" role="menuitem" disabled={busy} onClick={retry} className={actionClass}>{t("Retry")}</button> : null}
      {helper.state === 'outdated' ? <button type="button" role="menuitem" onClick={() => openExternal('https://github.com/flipspin/flipspin/releases/latest')} className={actionClass}>{t("Refresh")}</button> : null}
    </div> : offerMac ? <button type="button" role="menuitem" onClick={() => go('equipo')} className={`${rowClass} border-0 shadow-none bg-transparent hover:bg-[var(--paper)]`}><span className={iconClass}><Cpu size={16} aria-hidden /></span><span className="text-[13.5px] font-semibold">{t("Process for the nest")}</span></button> : null}
  </div>
}
