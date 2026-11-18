import type { ComponentType, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Missing } from '../../ui/react/components/Missing'
import { formatBytes } from '../format'
import { Word } from '../parts'
import { ExtensionState, type Extension } from '../extensions'

/** Built-ins and plugins share the same card shell and settings rows. */
export function AddonCard({ name, kind, icon: Icon, accent, description, onOpen, disabled, disabledTitle, expanded, engineState, children }: {
  name: string
  kind: string
  icon: ComponentType<{ size?: number; className?: string }>
  accent?: 'coral' | 'purple' | 'teal' | 'amber'
  description?: string
  onOpen?: () => void
  disabled?: boolean
  disabledTitle?: string
  expanded?: boolean
  engineState?: string
  children?: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return <section className={`settings-block ks-group cx-card${accent ? ` cx-card--accent cx-card--${accent}` : onOpen ? '' : ' cx-card--panel-2'}`} aria-label={name} data-engine-state={engineState}>
    <div className="cx-cardhead">
      <span className="cx-icon" aria-hidden><Icon size={20} /></span>
      <div className="ks-l"><b title={description}>{name}</b>{kind === t('Coming soon') ? <Word tone="off">{kind}</Word> : <span>{kind}</span>}</div>
      {onOpen ? <button type="button" className="ks-link" disabled={disabled} title={disabledTitle} aria-expanded={expanded} onClick={onOpen}>{expanded ? t("Close") : t("Open")}</button> : null}
    </div>
    {children}
  </section>
}

/** Keep disk usage first, with inclusion/sharing details on the size itself. */
export function AddonSize({ bytes, installed, estimate, details, shared }: {
  bytes?: number | null; installed: boolean; estimate: number; details: string
  shared?: { bytes?: number | null; with: string }
}): React.JSX.Element {
  const { t } = useTranslation()
  const measured = bytes != null && Number.isFinite(bytes) && bytes >= 0
  const estimated = t("Estimated", {  })
  const measurement = measured ? t("Measured on this computer") : installed ? t("Not measured on this computer yet") : estimated
  const sharedSize = shared?.bytes != null && Number.isFinite(shared.bytes) && shared.bytes >= 0
    ? formatBytes(shared.bytes) : `${t('≈ {{size}}', { size: formatBytes(200_000_000) })} (${estimated})`
  const title = [measurement, details, shared ? t("plus demucs {{size}}, shared with {{addon}}", { size: sharedSize, addon: shared.with }) : null].filter(Boolean).join(' · ')
  return measured ? <span title={title}>{formatBytes(bytes)}</span>
    : installed ? <Missing kind="unmeasured" reason={title} />
    : <span title={title}>{t('≈ {{size}}', { size: formatBytes(estimate) })}</span>
}

export function AddonRow({ label, size, value, title, mono, state, actions, extension, statePrefix }: {
  label: string; size?: ReactNode; value: ReactNode; title?: string; mono?: boolean; state: ReactNode; actions?: ReactNode; extension?: Extension; statePrefix?: ReactNode
}): React.JSX.Element {
  return <div className={`ks-row${mono ? ' cx-local' : ''}`}>
    <div className="ks-l"><b>{label}</b><span className={mono ? 'z-mono' : undefined} title={title}>{size ? <>{size} · </> : null}{value}{extension?.version ? <> · <code>{extension.version}</code></> : null}</span></div>
    <div className="ks-c">{statePrefix}{extension ? <ExtensionState extension={extension} /> : state}{actions}</div>
  </div>
}
