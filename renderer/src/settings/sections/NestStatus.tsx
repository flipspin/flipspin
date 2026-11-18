/** Switching servers relaunches the app because the selected origin determines
 * local server startup and which stored credential applies. */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'

import { apiPut, isApiError, queryKeys, useServerHost, type ServerHost } from '../../data'
import { ChangeNestDialog } from '../../onboarding/ChangeNestDialog'
import { useSettings } from '../context'
import { useNest } from '../nest'
import { Modal, QueryFailure, Skel, Tipped, Word, useToast } from '../parts'
import { NestCard } from './Overview'
import { Page } from './Head'
import { UpdateValues } from '../update'
import { BackupRow } from '../BackupRow'
import { useServerUpdate } from '../data'
import { ago } from '../../remote/rules'
import { reachWord } from '../../remote/reachWord'
import { Missing } from '../../ui/react/components/Missing'
import { LiveUpdatesRow } from '../LiveUpdates'
import { LibraryWatchRow } from '../LibraryWatch'

function Rename({ name, onDone }: { name: string; onDone: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(name)
  const [busy, setBusy] = useState(false)

  const save = async (next: string, undoTo?: string) => {
    setBusy(true)
    try {
      await apiPut('/api/server/name', { body: { name: next } })
      await queryClient.invalidateQueries({ queryKey: queryKeys.server.all })
      onDone()
      toast(t("Nest renamed"), undoTo === undefined ? {} : { undo: () => void save(undoTo) })
    } catch (error) {
      const status = isApiError(error) ? error.status : null
      toast(status === 422 ? t("That name is not valid. Try a shorter one.") : t("Could not change the name"), { err: true })
    } finally {
      setBusy(false)
    }
  }

  const changed = draft.trim() !== '' && draft.trim() !== name
  return (
    <form
      className="settings-rename"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed && !busy) void save(draft.trim(), name)
      }}
    >
      <input className="ks-field" value={draft} aria-label={t("Nest name")} maxLength={60} autoFocus onChange={(e) => setDraft(e.target.value)} />
      <button className="ks-btn ks-btn--sm ks-btn--ghost" type="button" onClick={onDone}>
        {t("Cancel")}
      </button>
      <button className="ks-btn ks-btn--sm settings-ink" type="submit" disabled={!changed || busy}>
        {t("Save")}
      </button>
    </form>
  )
}

function Version({ host }: { host: ReturnType<typeof useServerHost> }): React.JSX.Element {
  const { t } = useTranslation()
  const { server, admin } = useSettings()
  const nest = useNest(server)
  const update = useServerUpdate(admin === true).data

  return (
    <div className="settings-block ks-group" id="aj-version" tabIndex={-1} aria-labelledby="aj-version-title">
      <div className="settings-block__head">
        <h3 id="aj-version-title">{t("Version")}</h3>
        {update?.latest && update.checking ? <div className="ks-tools"><Word tone={update.updateAvailable || update.lastError && update.lastError !== 'no-release' ? 'warn' : 'ok'} title={update.lastError && update.lastError !== 'no-release' ? t("It will retry automatically") : undefined}>{t(update.updateAvailable ? "Update available" : "Up to date")}{update.lastError && update.lastError !== 'no-release' ? ` · ${t("GitHub did not respond")}` : ''}</Word></div> : null}
      </div>
      {nest.kind === 'loading' ? (
        <Skel rows={2} label={t("Loading the version")} />
      ) : (
        <div className="settings-block__body">
          <dl className={update ? "settings-kv settings-version" : "settings-kv"}>
            {update ? <UpdateValues value={update} /> : <div><dt>{t("Version")}</dt><dd className="z-mono">{nest.version || <Unknown />}</dd></div>}
            <div>
              <dt>{t("Address")}</dt>
              <dd className="z-mono">{nest.address || <Unknown />}</dd>
            </div>
            {admin === true ? (
              <div>
                <dt>{t("Running for")}</dt>
                <dd className="z-mono">{host.isPending ? <Skel rows={1} label={t("Loading…")} /> : <><HostAge at={host.data?.startedAt} />{nest.instanceId ? <span title={nest.instanceId}> · ID {nest.instanceId.length > 8 ? `${nest.instanceId.slice(0, 8)}…` : nest.instanceId}</span> : null}</>}</dd>
              </div>
            ) : null}
            {admin === true ? <BackupRow host={host} /> : null}
          </dl>
        </div>
      )}
    </div>
  )
}

/** Unknown facts stay visibly unknown, with the platform limitation in a tooltip. */
function Unknown(): React.JSX.Element {
  const { t } = useTranslation()
  return <Missing kind="unavailable" reason={t("The nest’s operating system could not report this detail.")} />
}

function HostAge({ at }: { at: string | null | undefined }): React.JSX.Element {
  const { t } = useTranslation()
  return at && Number.isFinite(Date.parse(at))
    ? <span title={at}>{reachWord(t, ago(Math.max(0, (Date.now() - Date.parse(at)) / 1000), { weeks: true }))}</span>
    : <Unknown />
}

function shortOS(name: string): string {
  return name.replace(/ GNU\/Linux| Linux/g, '').replace(/^Darwin$/, 'macOS')
}

function shortCPU(model: string): string {
  return model.replace(/\(R\)|\(TM\)/gi, '').replace(/\s+CPU\b.*$/i, '').replace(/\s+@.*$/, '').trim()
}

function Computer({ host }: { host: ReturnType<typeof useServerHost> }): React.JSX.Element {
  const { t } = useTranslation()
  const { server } = useSettings()
  const status = server.kind === 'ready' ? server.value : null
  const where = status?.mode === 'child' ? t("This computer") : t("Another computer on the network")
  const whereTip = status?.mode === 'child'
    ? t("This app starts it and it closes with it.") : t("It is on another computer on your network; this app neither opens nor closes it.")
  const data = host.data
  const value = (fact: ReactNode) => fact == null || fact === '' ? <Unknown /> : fact
  const row = (label: string, fact: ReactNode, mono = false) => <div key={label} className={label === t("Memory") ? 'settings-memoryrow' : undefined}><dt>{label}</dt><dd className={mono ? 'z-mono' : undefined}>{value(fact)}</dd></div>
  const isolation = (kind: ServerHost['isolation']) => {
    switch (kind) {
      case 'lxc': return t("LXC container")
      case 'docker': return t("Docker container")
      case 'vm': return t("Virtual machine")
      case 'none': return t("None")
      default: return <Unknown />
    }
  }
  const total = data?.memory?.total
  const used = data?.memory?.used
  const hasMemory = total != null && used != null && total > 0 && used >= 0
  // Binary GB match the machine's assigned RAM (4 GiB in the approved mock).
  const gb = (n: number) => Number((n / 1024 ** 3).toFixed(1)).toString()
  const kernel = data?.kernel?.match(/^(\d+\.\d+)/)?.[0]
  const kernelName = data?.os?.name === 'macOS' ? 'Darwin' : data?.os?.name?.includes('Linux') ? 'Linux' : ''
  const system = [[data?.os?.name ? shortOS(data.os.name) : null, data?.os?.version].filter(Boolean).join(' '), [kernelName, kernel].filter(Boolean).join(' '), data?.arch,
    data?.isolation && data.isolation !== 'none' ? isolation(data.isolation) : null, data?.hypervisor === 'proxmox' ? 'Proxmox' : data?.hypervisor].filter(Boolean)
  const systemTip = [data?.isolation === 'none' ? `${t("Virtualization")}: ${t("None")}` : null, data?.cpu?.model ? shortCPU(data.cpu.model) : null, data?.cpu?.cores != null ? t("{{count}} cores", { count: data.cpu.cores }) : null,
    data?.python ? `${t('Python')} ${data.python}` : null, data?.bootedAt ? `${t("Host uptime")} · ${reachWord(t, ago(Math.max(0, (Date.now() - Date.parse(data.bootedAt)) / 1000), { weeks: true }))}` : null,
    data?.engine ? `${t("Lyrics and stems")}: ${t(data.engine === 'agent' ? "On another computer" : "On this computer_device")}${data.arch?.includes('x86') ? ` · ${t("this computer is x86")}` : ''}` : null].filter(Boolean).join(' · ')

  return <section className="settings-block ks-group" aria-label={t("Computer")}>
    <div className="settings-block__head"><h3>{t("Computer")}</h3></div>
    {host.isPending ? <Skel rows={8} label={t("Loading host")} /> : host.isError ? (
      <QueryFailure error={host.error} what={t("the host")} onRetry={() => void host.refetch()} />
    ) : data ? <div className="settings-block__body"><dl className="settings-kv">
      <div><dt><Tipped tip={whereTip}>{t("Location")}</Tipped></dt><dd>{where} · <span className="z-mono">{value(data.hostname)}</span></dd></div>
      {row(t("System_system"), <span title={systemTip}>{system.length ? system.map((part, i) => <span key={i}>{i ? ' · ' : ''}{part}</span>) : <Unknown />}</span>)}
      {row(t("Memory"), hasMemory ? <span className="settings-meterline"><span className="z-mono">{t("{{used}} of {{total}} GB", { used: gb(used), total: gb(total) })}</span><span className="z-meter" role="meter" aria-label={t("Memory")} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used}><i style={{ width: `${Math.min(100, used / total * 100)}%` }} /></span></span> : null)}
    </dl></div> : null}
  </section>
}

function ThisApp(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { server } = useSettings()
  const nest = useNest(server)
  const [picking, setPicking] = useState(false)
  const status = server.kind === 'ready' ? server.value : null
  const thisComputer = status?.mode === 'child'

  return (
    <div className="settings-block ks-group">
      <div className="settings-block__head">
        <h3>{t("This app uses")}</h3>
      </div>
      <div className="ks-row">
        <span className="ks-l">
          <b>{nest.name ?? t("Your nest")}</b>
          <span className="z-mono z-faint">{thisComputer ? t("this device") : nest.address}</span>
        </span>
        <button className="ks-btn ks-btn--sm" type="button" onClick={() => setPicking(true)}>
          {t("Change nest")}
        </button>

      </div>
      {picking && <ChangeNestDialog mode={status?.mode ?? null} onClose={() => setPicking(false)} />}
    </div>
  )
}

export function NestStatus(): React.JSX.Element {
  const { t } = useTranslation()
  const { server, admin, surface } = useSettings()
  const nest = useNest(server)
  const host = useServerHost(admin === true)
  const [renaming, setRenaming] = useState(false)
  const name = nest.name ?? t("Your nest")

  return (
    <Page id="nido">
      <NestCard big>
        {renaming && nest.name ? (
          <Rename name={nest.name} onDone={() => setRenaming(false)} />
        ) : (
          <span className="settings-nest__name">
            {name}
            {admin === true && nest.name ? (
              <button
                className="ks-btn settings-nest-rename"
                type="button"
                title={t("Rename the nest")}
                aria-label={t("Rename the nest")}
                onClick={() => setRenaming(true)}
              >
                <Pencil className="i" aria-hidden />{t("Rename")}
              </button>
            ) : null}
          </span>
        )}
      </NestCard>
      <section className="settings-block ks-group" aria-label={t('This nest')}>
        <div className="settings-block__head"><h3>{t('This nest')}</h3></div>
        <LiveUpdatesRow />
        <LibraryWatchRow />
      </section>
      <Version host={host} />
      {admin === true ? <Computer host={host} /> : null}
      {surface === 'app' ? <ThisApp /> : null}
    </Page>
  )
}
