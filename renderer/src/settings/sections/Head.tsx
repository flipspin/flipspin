import { useOffline } from '../../offline/useOffline'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useSettings } from '../context'
import { sectionOf, type SectionId } from '../sections'

/** A section's title, with its hue as a dot (none on "Overview"). */
export function SectionHead({ id, sub, action }: { id: SectionId; sub?: ReactNode; action?: ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const section = sectionOf(id)
  const heading = (
    <h2 className="settings-h" id={`settings-h-${id}`}>
      {t(section.title ?? section.label)}
      {sub ? <span className="settings-h__sub">{sub}</span> : null}
    </h2>
  )
  return action ? <div className="settings-pagehead">{heading}{action}</div> : heading
}

/** The `<section>` every page is, labelled by its head. */
export function Page({ id, children, sub, before, action }: { id: SectionId; children: ReactNode; sub?: ReactNode; before?: ReactNode; action?: ReactNode }): React.JSX.Element {
  const section = sectionOf(id)
  const { t } = useTranslation()
  const { go } = useSettings()
  const blocked = useOffline() && ['cuenta', 'dispositivos', 'cuentas', 'remoto'].includes(id)
  return (
    <section className="settings-page" aria-labelledby={`settings-h-${id}`} style={{ '--_c': section.hue } as React.CSSProperties}>
      {section.parent && id !== 'health' ? <div className="cx-crumb"><button className="ks-link" type="button" onClick={() => go(section.parent!)}>{t(sectionOf(section.parent).label)}</button><span>›</span></div> : null}
      {before}
      <SectionHead id={id} sub={sub} action={action} />
      {blocked ? <fieldset disabled title={t("Account actions require the nest")} className="offline-account-actions">{children}</fieldset> : children}
    </section>
  )
}
