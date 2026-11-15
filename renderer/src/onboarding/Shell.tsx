/** Step content stays independent of the frame; the plan supplies progress and accents. */
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import '../ui/tokens/base.css'
import '../ui/primitives.css'
import '../setup/setup.css'
import './onboarding.css'

import { useWizardSteps, type StepId } from './plan'
import { APP_NAME } from '../brand'

export function LanguageSwitch(): null {
  return null
}

export function Brand(): React.JSX.Element {
  return (
    <span className="kob-brand">
      <span className="kob-brand__mark" aria-hidden="true" />
      {APP_NAME}
    </span>
  )
}

/** Night tokens live only on this island, regardless of the app's mode. */
export function OnboardingSurface({ hue, children }: { hue: string; children: ReactNode }): React.JSX.Element {
  return (
    <div
      className="krobi-setup z-root krobi-onboarding"
      data-profile="night"
      style={{ '--kob-hue': `var(--accent-${hue}, var(--accent-coral))` } as CSSProperties}
    >
      {children}
    </div>
  )
}

export interface WizardFrameProps {
  step?: StepId
  /** Step illustrations stay in the recessed right column. */
  show: ReactNode
  /** Connection context stays in the frame header across steps. */
  host?: ReactNode
  title: string
  children: ReactNode
  /** Back navigation occupies the left side of the footer. */
  back?: ReactNode
  /** The footer groups the primary action and optional secondary actions on the right. */
  actions: ReactNode
  /** Wide steps omit the illustration column so the body spans the panel. */
  wide?: boolean
}

export function WizardFrame({ step, show, host, title, children, back, actions, wide = false }: WizardFrameProps): React.JSX.Element {
  const { t } = useTranslation()
  const steps = useWizardSteps()
  const at = steps.findIndex((s) => s.id === step)
  return (
    <OnboardingSurface hue={steps[at]?.hue ?? 'coral'}>
      <header className="kob-topbar">
        <Brand />
        {step && <ol className="kob-steps" aria-label={t("Steps")}>
          {steps.map((s, k) => (
            <li key={s.id} className={k < at ? 'is-past' : undefined} aria-current={k === at ? 'step' : undefined}
              title={t(s.tip ?? s.label, { app: APP_NAME })}
              style={{ '--kob-segment': `var(--accent-${s.hue})` } as CSSProperties}>
              <i aria-hidden="true" />
              <span>{t(s.label)}</span>
            </li>
          ))}
        </ol>}
        <div className="kob-topbar__nest">{host}</div>
      </header>
      <main className="kob-main">
        <section className="kob-panel" aria-labelledby="kob-title">
          <header className="kob-panel__head">
            <span className="kob-panel__dot" aria-hidden="true" />
            <span className="kob-panel__name">{t(steps[at]?.label ?? "Nest")}</span>
            {at >= 0 && <span className="kob-eyebrow">{t("Step {{n}} of {{total}}", { n: at + 1, total: steps.length })}</span>}
          </header>
          <div className={`kob-body${wide ? ' kob-body--wide' : ''}`}>
            <div className="kob-form">
              <h1 id="kob-title" className="kob-title kob-h">{title}</h1>
              {children}
            </div>
            {!wide && <div className="kob-figure" aria-hidden="true"><div className="kob-show__inner">{show}</div></div>}
          </div>
          <footer className="kob-foot">
            {back ?? <span />}
            <div className="kob-foot__end">{actions}</div>
          </footer>
        </section>
      </main>
    </OnboardingSurface>
  )
}

/** Icon paths use a 24×24 view box and the shared strokes in onboarding.css. */
export const ICONS = {
  home: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 22V12h6v10',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2|C12,7,4',
  music: 'M9 18V5l12-2v13|C6,18,3|C18,16,3',
  phone: 'R5,2,14,20|M12 18h.01',
  laptop: 'R3,4,18,12|M2 20h20',
  server: 'R2,2,20,8|R2,14,20,8|M6 6h.01|M6 18h.01',
  terminal: 'm4 17 6-6-6-6|M12 19h8',
  tailnet: 'C5,12,2|C12,12,2|C19,12,2|C12,5,2|C12,19,2',
  lock: 'R3,11,18,11|M7 11V7a5 5 0 0 1 10 0v4',
  globe: 'C12,12,10|M2 12h20|M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  house: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  cross: 'M18 6 6 18|M6 6l12 12',
  shieldOff: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z|m4.9 4.9 14.2 14.2',
} as const

export function Icon({ name }: { name: keyof typeof ICONS }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name].split('|').map((part, k) => {
        if (part.startsWith('C')) {
          const [cx, cy, r] = part.slice(1).split(',').map(Number)
          return <circle key={k} cx={cx} cy={cy} r={r} />
        }
        if (part.startsWith('R')) {
          const [x, y, width, height] = part.slice(1).split(',').map(Number)
          return <rect key={k} x={x} y={y} width={width} height={height} rx={2} />
        }
        return <path key={k} d={part} />
      })}
    </svg>
  )
}
