import { msg } from '../../i18n';
import '../../ui/tokens/app.css'
import '../../ui/overlay.css'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { ModalLayer } from '../../ui/react/components/ModalLayer'
import { useHeld } from '../../ui/react/useHeld'
import { placements, type Kind, type Limits } from './data'

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  const held = useHeld(open ? children : null)
  return <ModalLayer open={open} onClose={onClose} className="settings krobi-settings z-root bw-sheet" data-profile="krobi" aria-label={title} scrimClassName="bw-scrim">
    <header className="bw-sheet-head"><h3>{title}</h3><button type="button" className="ks-btn ks-btn--icon ks-btn--ghost" aria-label={t("Close")} onClick={onClose}><X className="i" aria-hidden /></button></header>
    <div className="bw-sheet-body">{held}</div>
  </ModalLayer>
}
export function Pace({ value, label, disabled, onChange }: { value: Limits['pace']; label: string; disabled?: boolean; onChange: (pace: Limits['pace']) => void }) {
  const { t } = useTranslation()
  return <div className="bw-pace" role="group" aria-label={label}>{(['fast', 'gentle', 'off'] as const).map(pace => <button type="button" aria-pressed={value === pace} key={pace} disabled={disabled} onClick={() => onChange(pace)}>{t(({ fast: msg("Fast"), gentle: msg("Gentle"), off: msg("Off") })[pace])}</button>)}</div>
}
export function Placement({ kind, disabled, onChange }: { kind: Kind; disabled?: boolean; onChange: (value: Kind['policy']['placement']) => void }) {
  const { t } = useTranslation()
  const tooSmall = kind.policy.requiredMemoryBytes > kind.nestMemoryBytes
  return <select className="ks-sel ks-sel--sm bw-placement" aria-label={t("{{kind}} may run on", { kind: t(({ align: msg("Lyrics sync_synchronization"), analysis: msg("Analysis"), stems: msg("Stems"), transcribe: msg("Lyrics sync_synchronization") })[kind.kind]) })} disabled={disabled} value={kind.policy.placement} onChange={event => onChange(event.target.value as Kind['policy']['placement'])}>
    {Object.entries(placements).map(([value, label]) => <option value={value} key={value} disabled={tooSmall && value !== 'helpers'}>{t(label)}{tooSmall && value !== 'helpers' ? ` · ${t("needs 8 GB")}` : ''}</option>)}
  </select>
}
