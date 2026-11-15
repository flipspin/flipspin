/** Revoking the current device signs this app out, so label its action "Sign out".
 * Drop minted tokens after the one-shot reveal; never put them in logs or notifications. */
import { ROLE_NAMES } from '../../pairing/messages'
import { ApproveCode } from './ApproveCode'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Globe, Laptop, LogOut, Music, Pencil, Smartphone } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { MusicAppRows } from '../../pairing/MusicAppRows'
import { SubsonicDeviceDialog } from '../../pairing/SubsonicDeviceDialog'
import { isPhoneLabel } from '../../pairing/deviceKind'
import { bridge } from '../../bridge'
import { apiPost, isApiError, queryKeys, serverDetail } from '../../data'
import { QrCode, buildAccessLink, isLoopbackServer, usePairing } from '../../pairing'
import { isMusicApp, addMyDevice, changeMyPassword, renameMyDevice, revokeMyDevice, type MyDevice } from '../gateways'
import { useSettings } from '../context'
import { useMyDevices } from '../data'
import { bareHost, formatSeen } from '../format'
import { CopyButton, Dot, QueryFailure, Modal, Skel, Word, useToast } from '../parts'
import { Page } from './Head'
import { Missing } from '../../ui/react/components/Missing'
import { DesktopSession } from './DesktopSession'
import { DeleteAccount } from './DeleteAccount'

/** The icon by what the label says the machine is. */
export function deviceIcon(label: string): LucideIcon {
  if (isPhoneLabel(label)) return Smartphone
  if (/\ben (mac|windows|linux)$|safari|firefox|chrome|edge|navegador/i.test(label)) return Globe
  if (/symfonium|play:sub|amperfy|feishin|subsonic/i.test(label)) return Music
  return Laptop
}

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

function statusOf(error: unknown): number | null {
  return isApiError(error) ? (error.status ?? null) : null
}

/* ───────────────────────────── the account ───────────────────────────── */

function PasswordForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const mismatch = again !== '' && next !== again

  const submit = async () => {
    setBusy(true)
    setProblem(null)
    try {
      await changeMyPassword({ currentPassword: current === '' ? null : current, newPassword: next })
      toast(t("Password changed · your other devices stay signed in"))
      onDone()
    } catch (error) {
      const status = statusOf(error)
      setProblem(
        status === 401
          ? t("That is not the current password")
          : status === 422
            ? t("The new password is too short")
            : status === 409
              ? t("This account has no username")
              : t("Could not change the password"),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="settings-pw"
      onSubmit={(event) => {
        event.preventDefault()
        if (next === '' || mismatch || busy) return
        void submit()
      }}
    >
      <label className="z-field">
        <span className="z-label">{t("Current password")}</span>
        <input className="ks-field" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="z-field">
        <span className="z-label">{t("New")}</span>
        <input className="ks-field" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="z-field">
        <span className="z-label">{t("Repeat the password")}</span>
        <input
          className="ks-field"
          type="password"
          autoComplete="new-password"
          aria-invalid={mismatch}
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </label>
      <span className="settings-pw__do">
        <button className="ks-btn ks-btn--sm ks-btn--ghost" type="button" onClick={onDone} disabled={busy}>
          {t("Cancel")}
        </button>
        <button className="ks-btn ks-btn--sm settings-ink" type="submit" disabled={next === '' || next !== again || busy}>
          {t("Save")}
        </button>
      </span>
      {mismatch || problem ? (
        <span className="z-err settings-pw__err" role="alert">
          {mismatch ? t("They don’t match") : problem}
        </span>
      ) : null}
    </form>
  )
}

function AccountHeader({ editable = false }: { editable?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { me, meStatus, mePending, meError, refreshMe } = useSettings()
  const [renaming, setRenaming] = useState<string | null>(null)

  if (me === null && mePending) {
    return (
      <div className="settings-me">
        <Skel rows={2} label={t("Loading your account")} />
      </div>
    )
  }
  if (me === null && meError && meStatus !== 401 && meStatus !== 409) {
    return <div className="settings-me"><QueryFailure error={meError} what={t("your account")} onRetry={refreshMe} /></div>
  }
  if (me === null) {
    return (
      <div className="settings-me">
        <div className="settings-me__name"><Missing kind="noAccount" reason={t(meStatus === 409 ? "This credential has no account of its own in this nest." : "This device isn't signed in with any account.")} /></div>
      </div>
    )
  }

  const own = me.source === 'token'
  const role = t(ROLE_NAMES[me.role === 'owner' ? 'owner' : 'member'])

  const rename = async (label: string, undoTo?: string) => {
    try {
      await apiPost('/api/me/label', { body: { label } })
      await queryClient.invalidateQueries({ queryKey: queryKeys.me.all })
      setRenaming(null)
      toast(t("Name changed"), undoTo === undefined ? {} : { undo: () => void rename(undoTo) })
    } catch {
      toast(t("Could not change the name"), { err: true })
    }
  }

  return (
    <div className="settings-me">
      <span className="settings-av settings-av--lg" style={{ '--_c': 'var(--accent-purple)' } as React.CSSProperties} aria-hidden>
        {own ? initial(me.label) : '?'}
      </span>
      <div className="settings-me__id">
        {renaming !== null ? (
          <form
            className="settings-inlineform"
            onSubmit={(event) => {
              event.preventDefault()
              if (renaming.trim() !== '' && renaming.trim() !== me.label) void rename(renaming.trim(), me.label)
            }}
          >
            <input className="ks-field" aria-label={t("Your name")} value={renaming} maxLength={80} autoFocus onChange={(e) => setRenaming(e.target.value)} />
            <button className="ks-btn ks-btn--sm ks-btn--ghost" type="button" onClick={() => setRenaming(null)}>
              {t("Cancel")}
            </button>
            <button className="ks-btn ks-btn--sm settings-ink" type="submit" disabled={renaming.trim() === '' || renaming.trim() === me.label}>
              {t("Save")}
            </button>
          </form>
        ) : (
          <span className="settings-me__name">
            {own ? me.label : <Missing kind="noAccount" reason={t("This credential has no account of its own in this nest.")} />}
          </span>
        )}
        <span className="settings-me__sub">
          {own && me.username ? (
            <>
              <span className="z-mono" title={t("Username")}>
                @{me.username}
              </span>{' '}
              ·{' '}
            </>
          ) : null}
          {own ? <span
            className={me.isOwner ? 'settings-tag' : undefined}
            title={me.isOwner ? t("Can create and delete accounts, and change nest settings") : t("Sees the nest’s library and has its own playlists")}
          >
            {role}
          </span> : null}
        </span>
      </div>
      {own && editable ? <button className="ks-btn" type="button" onClick={() => setRenaming(me.label)}><Pencil className="i" aria-hidden />{t("Rename")}</button> : null}
    </div>
  )
}

function AccountPassword(): React.JSX.Element {
  const { t } = useTranslation()
  const [changing, setChanging] = useState(false)
  return <>
    <div className="settings-block ks-group"><div className="ks-row"><div className="ks-l"><b>{t("Password")}</b><span>••••••••••</span></div><button className="ks-link" type="button" onClick={() => setChanging(true)}>{t("Change password")}</button></div></div>
    {changing ? <Modal title={t("Change password")} onClose={() => setChanging(false)}><PasswordForm onDone={() => setChanging(false)} /></Modal> : null}
  </>
}

/* ───────────────────────────── devices ───────────────────────────── */

function AddDevice({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { serverUrl } = usePairing()
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)

  const mint = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const minted = await addMyDevice(label.trim())
      setToken(minted.token)
      onAdded()
    } catch (error) {
      setProblem(statusOf(error) === 422 ? t("That name is not valid") : t("Could not create the code"))
    } finally {
      setBusy(false)
    }
  }

  const link = token ? buildAccessLink(serverUrl, token) : null
  return (
    <Modal title={t("Add device")} onClose={token ? () => {} : onClose} className="settings-modal--qr">
      {token === null ? (
        <form
          className="settings-qr__side"
          onSubmit={(event) => {
            event.preventDefault()
            if (label.trim() !== '' && !busy) void mint()
          }}
        >
          <label className="z-field">
            <span className="z-label">{t("Name")}</span>
            <input className="ks-field" value={label} maxLength={80} placeholder={t("Living-room iPad")} onChange={(e) => setLabel(e.target.value)} />
          </label>
          {problem ? (
            <span className="z-err" role="alert">
              {problem}
            </span>
          ) : null}
          <div className="settings-modal__do">
            <button className="ks-btn" type="button" onClick={onClose}>
              {t("Cancel")}
            </button>
            <button className="ks-btn ks-btn--go" type="submit" disabled={label.trim() === '' || busy}>
              {t("Create the code")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="settings-qr">
            {link ? (
              <QrCode payload={link} size={180} />
            ) : (
              <span title={isLoopbackServer(serverUrl) ? t("To pair a phone, this computer needs to be on your network.") : t("No code: copy the address and the token")}>{t("Address")} · {t('Token')}</span>
            )}
            <div className="settings-qr__side">
              <b>{label.trim()}</b>
              <Word tone="warn">{t("shown only once")}</Word>
              <dl className="settings-kv settings-kv--copy">
                <div>
                  <dt>{t("Address")}</dt>
                  <dd className="z-mono">
                    <span title={t("The address the phone will open")}>{bareHost(serverUrl)}</span>
                    <CopyButton value={serverUrl} />
                  </dd>
                </div>
                <div>
                  <dt>{t('Token')}</dt>
                  <dd className="z-mono">
                    <span>••••••••</span>
                    <CopyButton value={token} label={t("Copy the token")} />
                  </dd>
                </div>
              </dl>
            </div>
          </div>
          <div className="settings-modal__do">
            <button className="ks-btn" type="button" onClick={onClose}>
              {t("Done")}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

function DeviceRow({ device, onRevoke, onSignOut }: { device: MyDevice; onRevoke: () => void; onSignOut: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [label, setLabel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const rename = async () => {
    if (label === null || !label.trim() || busy) return
    setBusy(true)
    setProblem(null)
    try {
      await renameMyDevice(device.id, label.trim())
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.me.devices() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.household.all }),
      ])
      setLabel(null)
    } catch (error) {
      setProblem(statusOf(error) === 422 ? t("That name is not valid") : statusOf(error) === 404 && serverDetail(error) === 'Not Found' ? t("Update the nest to use this feature.") : t("Could not change the name"))
    } finally {
      setBusy(false)
    }
  }
  const Icon = deviceIcon(device.label)
  return (
    <div className={`settings-dev${device.isCurrent ? ' is-here' : ''}`}>
      <span className="settings-dev__ic">
        <Icon className="i" aria-hidden />
      </span>
      {label !== null ? <form className="settings-inlineform settings-dev__rename" onSubmit={event => { event.preventDefault(); void rename() }}>
        {device.isCurrent ? <span className="settings-here">{t("this device")}</span> : null}
        <input className="ks-field" aria-label={t("Device name")} value={label} maxLength={80} autoFocus disabled={busy} aria-invalid={Boolean(problem)} aria-describedby={problem ? `device-error-${device.id}` : undefined} onChange={event => { setLabel(event.target.value); setProblem(null) }} />
        <button className="ks-btn ks-btn--sm ks-btn--ghost" type="button" disabled={busy} onClick={() => { setLabel(null); setProblem(null) }}>{t("Cancel")}</button>
        <button className="ks-btn ks-btn--sm settings-ink" type="submit" disabled={busy || !label.trim() || label.trim() === device.label}>{t("Save")}</button>
        {problem ? <span className="z-err settings-dev__error" id={`device-error-${device.id}`} role="alert">{problem}</span> : null}
      </form> : <span className="settings-dev__name">
        <b>{device.label}</b>
        {device.isCurrent ? <span className="settings-here">{t("this device")}</span> : null}
      </span>}
      <span className="settings-dev__seen">
        {device.isCurrent ? <Dot tone="ok" /> : null}
        {device.isCurrent ? t("now") : formatSeen(device.lastSeenAt)}
      </span>
      {label === null ? <div className="settings-dev__actions">
      <button className="ks-link" type="button" onClick={() => setLabel(device.label)}>{t("Rename")}</button>
      {device.isCurrent ? (
        <button className="ks-link" type="button" title={t("This computer stops signing in with your account. Nothing on the nest is deleted.")} onClick={onSignOut}>
          <LogOut className="i" aria-hidden />
          {t("Sign out")}
        </button>
      ) : (
        <button className="ks-link" type="button" onClick={onRevoke}>
          {t("Remove")}
        </button>
      )}
      </div> : null}
    </div>
  )
}

function Devices({ onSignOut }: { onSignOut: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const devices = useMyDevices(true)
  const [adding, setAdding] = useState(false)
  const [approving, setApproving] = useState(false)
  const [revoking, setRevoking] = useState<MyDevice | null>(null)

  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.me.devices() })

  const revoke = async (device: MyDevice) => {
    try {
      const result = await revokeMyDevice(device.id)
      setRevoking(null)
      refresh()
      if (result.signedOutThisDevice) await bridge().invoke('auth:clear', undefined).catch(() => undefined)
      toast(t("Device removed"))
    } catch (error) {
      setRevoking(null)
      toast(statusOf(error) === 422 ? t("It is your account’s only device: the nest won’t remove it") : t("Could not remove it · it stays signed in"), { err: true })
    }
  }

  const list = (devices.data ?? []).filter(device => !isMusicApp(device))
  return (
    <div className="settings-block ks-group">
      <div className="settings-block__head">
        <h3 id="aj-dispositivos" tabIndex={-1} title={list.length === 1 ? t("Only this computer signs in with your account.") : undefined}>{t("Devices")}</h3>
        {devices.data ? <span className="settings-count z-mono">{list.length}</span> : null}
        <div className="settings-head-act settings-device-actions">
          <button className="ks-btn ks-btn--sm ks-btn--ghost" type="button" onClick={() => setApproving(true)}>
            {t("Approve code")}
          </button>
          <button className="ks-btn ks-btn--sm ks-btn--go" type="button" onClick={() => setAdding(true)}>
            {t("Add device")}
          </button>
        </div>
      </div>
      {devices.isPending ? (
        <Skel rows={3} label={t("Loading your devices")} />
      ) : devices.isError ? (
        <QueryFailure error={devices.error} what={t("your devices")} onRetry={() => void devices.refetch()} />
      ) : (
        <div className="settings-block__body" aria-labelledby="aj-dispositivos">
          {[...list]
            .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
            .map((device) => (
              <DeviceRow key={device.id} device={device} onRevoke={() => setRevoking(device)} onSignOut={onSignOut} />
            ))}
        </div>
      )}
      {approving ? <ApproveCode onClose={() => setApproving(false)} /> : null}
      {adding ? <AddDevice onClose={() => setAdding(false)} onAdded={refresh} /> : null}
      {revoking ? (
        <Modal title={t("Remove {{name}}?", { name: revoking.label })} onClose={() => setRevoking(null)}>

          <div className="settings-modal__do">
            <button className="ks-btn" type="button" onClick={() => setRevoking(null)}>
              {t("Cancel")}
            </button>
            <button title={t("It stops signing in to your account right away. To come back it has to be added again with a code.")} className="ks-btn ks-btn--danger" type="button" onClick={() => void revoke(revoking)}>
              {t("Remove")}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

function SignOut({ close }: { close: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [removeDownloads, setRemoveDownloads] = useState(false)
  const signOut = async () => {
    close()
    try {
      if (removeDownloads) await bridge().invoke('offline:pools', { action: 'remove-downloads' })
      const result = await bridge().invoke('auth:clear', undefined)
      if (!result.ok) throw new Error('auth:clear')
    } catch {
      toast(t("Could not sign out"), { err: true })
    }
  }

  return (
    <Modal title={t("Sign out on this computer?")} onClose={close}>
      <label className="ks-row"><input type="checkbox" checked={removeDownloads} onChange={event => setRemoveDownloads(event.target.checked)} />{t("Delete this account’s downloads?")}</label>

      <div className="settings-modal__do">
        <button className="ks-btn" type="button" onClick={close}>
          {t("Cancel")}
        </button>
        <button title={t("Signing back in takes your password or a code. Nothing on the nest is deleted.")} className="ks-btn ks-btn--danger" type="button" onClick={() => void signOut()}>
          {t("Sign out")}
        </button>
      </div>
    </Modal>
  )
}

/* ───────────────────────────── app passwords ───────────────────────────── */

function MusicApps(): React.JSX.Element {
  const devices = useMyDevices(true)
  const { t } = useTranslation()
  const { serverUrl } = usePairing()
  const { me } = useSettings()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  return (
    <div className="settings-block ks-group">
      <div className="settings-block__head">
        <h3>
          <span
            className="settings-tipped"
            tabIndex={0}
            title={t("Access for Subsonic and OpenSubsonic apps.")}
          >
            {t("Music apps")}
          </span>
        </h3>
        <span className="settings-count">
          {devices.data ? devices.data.filter(isMusicApp).length : '…'}
        </span>
      </div>
      {devices.isError ? <QueryFailure error={devices.error} what={t("your devices")} onRetry={() => void devices.refetch()} /> : null}
      {devices.data ? <MusicAppRows heading={false} devices={devices.data} onRemoved={() => void queryClient.invalidateQueries({ queryKey: queryKeys.me.devices() })} /> : null}
      <div className="settings-modal__do"><button className="ks-btn" type="button" onClick={() => setAdding(true)}>{t("Add a music app")}</button></div>
      {adding ? (
        <SubsonicDeviceDialog serverUrl={serverUrl} username={me?.username} onClose={() => setAdding(false)} onAdded={() => void queryClient.invalidateQueries({ queryKey: queryKeys.me.devices() })} />
      ) : null}
    </div>
  )
}

export function MyAccount(): React.JSX.Element {
  const { t } = useTranslation()
  const { me, go } = useSettings()
  const queryClient = useQueryClient()
  const [leaving, setLeaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const own = me?.source === 'token'
  return (
    <Page id="cuenta">
      <AccountHeader editable />
      {own ? <AccountPassword /> : null}
      <DesktopSession onSignOut={() => setLeaving(true)} onDevices={own ? () => go('dispositivos') : undefined} />
      {own ? <div className="settings-block ks-group"><div className="ks-row"><div className="ks-l"><b className="settings-danger">{t("Delete account_theAccount")}</b></div><button className="ks-link settings-danger" type="button" onClick={() => setDeleting(true)}>{t("Delete")}</button></div></div> : null}
      {deleting && me && own ? <DeleteAccount person={{ ...me, role: me.isOwner ? 'owner' : 'member', createdAt: me.createdAt ?? null, lastSeenAt: me.lastSeenAt ?? null }} own onClose={() => setDeleting(false)} onDeleted={() => void queryClient.invalidateQueries({ queryKey: queryKeys.me.all })} /> : null}
      {leaving ? <SignOut close={() => setLeaving(false)} /> : null}
    </Page>
  )
}

export function MyDevices(): React.JSX.Element {
  const { me } = useSettings()
  const [leaving, setLeaving] = useState(false)
  return (
    <Page id="dispositivos">
      <AccountHeader />
      {me?.source === 'token' ? <>
        <Devices onSignOut={() => setLeaving(true)} />
        <MusicApps />
      </> : null}
      {leaving ? <SignOut close={() => setLeaving(false)} /> : null}
    </Page>
  )
}
