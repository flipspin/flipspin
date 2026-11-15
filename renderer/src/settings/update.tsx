/** Release facts in the nest's Version card; feed prose never enters this view. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { openExternal } from '../ui/components/cardArt'
import { apiDelete, apiPost, apiPut, queryKeys } from '../data'
import { useSettings } from './context'
import type { ServerUpdate } from './data'
import { formatAgo } from './format'
import { Tipped, useToast } from './parts'

export function UpdateValues({ value: v }: { value: ServerUpdate }): React.JSX.Element {
  const { t } = useTranslation()
  const { go } = useSettings()
  const toast = useToast()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const behind = v.checking && v.updateAvailable
  const unpublished = v.latest === null && v.lastError === 'no-release'
  const word = !v.checking ? t("Update checks disabled") : unpublished ? t("No published versions") : !v.latest ? t("Searching") : behind ? t("Update available") : t("Up to date")
  const tip = !v.checking ? t("Update checks are disabled") : unpublished ? t("Flipspin has not published any versions yet") : undefined
  const install = { script: t("Install script"), compose: t('Docker Compose'), unraid: t('Unraid'), systemd: t('systemd'), desktop: t("Desktop app"), unknown: t("Unknown") }[v.install]
  const how = v.pinned && v.install === 'script' ? t("Pinned version") : v.install === 'unraid' ? t("From Docker in Unraid") : null
  const howTip = v.pinned && v.install === 'script' ? t("The nest stays on the version pinned at installation; krobi update does not change it") : t("Unraid › Docker › Flipspin › Update")
  const check = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await apiPost('/api/server/update/check')
      client.setQueryData(queryKeys.server.update(), result)
      void client.invalidateQueries({ queryKey: queryKeys.me.attention() })
    } catch {
      toast(t("Could not check for updates"), { err: true })
    } finally { setBusy(false) }
  }
  const skip = async () => {
    if (busy || !v.latest) return
    setBusy(true)
    try {
      const result = v.skipped === v.latest
        ? await apiDelete('/api/server/update/skip')
        : await apiPut('/api/server/update/skip', { body: { version: v.latest } })
      client.setQueryData(queryKeys.server.update(), result)
      void client.invalidateQueries({ queryKey: queryKeys.me.attention() })
    } catch { toast(t("Could not change the notice"), { err: true }) }
    finally { setBusy(false) }
  }
  const copy = async () => {
    if (!v.command) return
    try {
      await navigator.clipboard.writeText(v.command)
      toast(t("Command copied"))
    } catch { toast(t("Could not copy"), { err: true }) }
  }
  return <>
    <div><dt><Tipped tip={t("The latest published version of Flipspin")}>{t("Version")}</Tipped></dt><dd>
      <span title={tip}><span className="z-mono">{v.current}</span>{behind && v.latest ? <span className="z-mono"> → {v.latest}</span> : !v.latest || !v.checking ? ` · ${word.toLocaleLowerCase()}` : null}</span>
      <span className="settings-row-actions">{behind && v.releaseUrl ? <a className="settings-update-link" href={v.releaseUrl} title={t("github.com/flipspin/flipspin")} onClick={e => { e.preventDefault(); openExternal(v.releaseUrl) }}>{t("New releases")}<ArrowUpRight aria-hidden /></a> : null}
      {behind ? <button type="button" className="settings-update-link" disabled={busy} onClick={() => void skip()}>{v.skipped === v.latest ? t("Notify me again") : t("Skip this version")}</button> : null}
      {!v.checking ? <button type="button" className="settings-update-link" onClick={() => go('network')}>{t("Network")} ›</button> : null}</span>
    </dd></div>
    <div><dt><Tipped tip={t("On the computer running the nest")}>{t("Refresh")}</Tipped></dt><dd>
      <span title={how ? howTip : undefined}>{install}{v.pinned && v.install === 'script' ? <> · {t("pinned to {{version}}", { version: v.current })}</> : null}{how ? ` · ${how}` : ''}</span>
      {behind && v.command ? <span className="settings-cmd settings-row-actions"><code>{v.command}</code><button className="ks-btn" type="button" onClick={() => void copy()}>{t("Copy")}</button></span> : null}
    </dd></div>
    {v.checking ? <div><dt title={v.lastError && v.lastError !== 'no-release' ? t("It will retry automatically") : undefined}>{t("Last search")}</dt><dd>
      <span className="z-mono">{v.checkedAt ? formatAgo(Date.parse(v.checkedAt)) : t("not yet")}</span>

      <button type="button" className="ks-btn ks-btn--ghost settings-update-check settings-row-actions" title={t("At most once every 5 minutes")} disabled={busy} onClick={() => void check()}>{t("Search now")}</button>
    </dd></div> : null}
  </>
}
