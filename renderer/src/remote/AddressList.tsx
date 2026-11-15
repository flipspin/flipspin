/**
 * "Addresses": every address the nest answers at, each with its own check
 * and a copy button, under the one status line. Drawn by the wizard's
 * "Remote access" (glass, `onboarding.css`) and by Settings → Nest
 * (`server-settings.css`); the markup is shared, each surface styles `ra-*`.
 */
import { useTranslation } from 'react-i18next'

import { APP_NAME } from '../brand'
import { Button } from '../ui/react/components/Button'
import { CopyButton } from '../onboarding/CopyButton'
import { REACH_WORD, VERDICT_WORD, type AddressRow, type Reach, type RowKind, type RowState } from './useNestAddresses'
import { Missing } from '../ui/react/components/Missing'

/** Tooltips: the wizard draws `data-tip`; Settings has only the native `title`. */
export type TipAttr = 'data-tip' | 'title'

function tip(attr: TipAttr, text: string): Record<string, string | number> {
  return attr === 'data-tip' ? { 'data-tip': text, tabIndex: 0 } : { title: text }
}

export function ReachLine({ reach, detail }: { reach: Reach; detail?: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span className="ra-status" data-state={reach} role="status">
      <i aria-hidden="true" />
      <b>{t(REACH_WORD[reach])}</b>
      {detail && <span className="ra-status__detail">{detail}</span>}
    </span>
  )
}

export interface AddressListProps {
  rows: AddressRow[]
  stateOf: (url: string) => RowState
  onCheck: () => void
  checking: boolean
  /** The row the chosen route goes through, marked with the accent. */
  active?: RowKind | null
  readOnly?: boolean
  tipAttr: TipAttr
}

export function AddressList({ rows, stateOf, onCheck, checking, active = null, tipAttr, readOnly = false }: AddressListProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="ra-addrs">
      <div className="ra-addrs__head">
        <span className="ra-k">{t("Addresses")}</span>
        {!readOnly ? <Button
          size="sm"
          loading={checking}
          disabled={rows.length === 0}
          onClick={onCheck}
          {...tip(tipAttr, t("Check that each address reaches this nest."))}
          data-tip-pos="end"
        >
          {t("Check_review")}
        </Button> : null}
      </div>
      <ul className="ra-list" aria-label={t("Addresses")}>
        {rows.map((row) => {
          const state = stateOf(row.url)
          return (
            <li key={`${row.kind}-${row.url}`} className={`ra-row${active === row.kind ? ' is-on' : ''}`}>
              <span className="ra-row__label">{t(row.label)}</span>
              <span className="ra-row__addr" {...(row.shown !== row.url ? tip(tipAttr, row.url) : {})}>
                {row.shown}
              </span>
              {state === null ? (
                <span className="ra-st" data-v="none">
                  <i aria-hidden="true" /><Missing kind="unverified" />
                </span>
              ) : state === 'busy' ? (
                <span className="ra-st" data-v="busy">
                  <i aria-hidden="true" />…
                </span>
              ) : (
                <span
                  className="ra-st"
                  data-v={state}
                  {...(state === 'unreachable' && row.kind === 'domain'
                    ? tip(tipAttr, t("From the local network it can fail and still work outside."))
                    : {})}
                >
                  <i aria-hidden="true" />
                  {t(VERDICT_WORD[state], { app: APP_NAME })}
                </span>
              )}
              <CopyButton text={row.url} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
