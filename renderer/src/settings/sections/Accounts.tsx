/** Fetch devices on expansion to retain the shipped account-list shape.
 * Offer undo for renaming and confirm account deletion because it cannot be reversed. */
import { ResetPassword } from './ResetPassword'
import { DeleteAccount } from './DeleteAccount'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ChevronRight, Plus } from 'lucide-react'

import { isPairingError, QrCode, ROLE_NAMES, buildAccessLink, isLoopbackServer, usePairing, type PairedDevice, type Role } from '../../pairing'
import { queryKeys } from '../../data'
import { listAccountDevices, renameAccount } from '../gateways'
import { accountDevicesFailure } from '../messages'
import { useSettings } from '../context'
import { householdGateway, useAccounts } from '../data'
import { bareHost, formatSeen } from '../format'
import { CopyButton, ErrorAlt, QueryFailure, Modal, Seg, Skel, Word, useToast } from '../parts'
import { Page } from './Head'

const HUES = ['var(--accent-purple)', 'var(--accent-yellow)', 'var(--accent-blue)', 'var(--accent-teal)', 'var(--accent-rose)', 'var(--accent-green)']

function hueOf(id: string): string {
  let sum = 0
  for (const char of id) sum = (sum + char.charCodeAt(0)) % 997
  return HUES[sum % HUES.length]
}

function Avatar({ person }: { person: PairedDevice }): React.JSX.Element {
  return (
    <span className="settings-av" style={{ '--_c': hueOf(person.id) } as React.CSSProperties} aria-hidden>
      {(person.label.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

function RoleWord({ role }: { role: Role }): React.JSX.Element {
  const { t } = useTranslation()
  return role === 'owner' ? <span className="settings-tag">{t(ROLE_NAMES.owner)}</span> : <>{t(ROLE_NAMES.member)}</>
}

function AccountBody({
  person,
  onlyAdmin,
  onRename,
  onDelete,
  onReset,
  devices,
}: {
  person: PairedDevice
  onlyAdmin: boolean
  onRename: () => void
  onDelete: () => void
  onReset?: () => void
  devices: UseQueryResult<Awaited<ReturnType<typeof listAccountDevices>>>
}): React.JSX.Element {
  const { t } = useTranslation()
  const failure = devices.isError ? accountDevicesFailure(devices.error) : null
  return (
    <div className="settings-acc__body ka-sub">
      <div className="ks-row"><div className="ks-l"><b>{t("Devices")}</b>
      {devices.isPending ? (
        <Skel rows={1} />
      ) : failure ? (
        failure.fact ? (
          <span className="z-say settings-alt--panel-2">{failure.text}</span>
        ) : (
          <ErrorAlt what={t("its devices")} onRetry={() => void devices.refetch()} />
        )
      ) : devices.data && devices.data.length > 0 ? (
        <span>{devices.data.map(device => `${device.label} · ${formatSeen(device.lastSeenAt)}`).join(', ')}</span>
      ) : (
        <span className="z-say">{t("Has not signed in from any device yet.")}</span>
      )}
      </div></div>
      <div className="ks-row"><div className="ks-l"><b>{t("Name")}</b><span>{person.label}</span></div><div className="ks-c">
        <button className="ks-link" type="button" onClick={onRename}>
          {t("Rename")}
        </button>
      </div></div>
      {onReset ? <div className="ks-row"><div className="ks-l"><b>{t("Password")}</b><span>••••••••</span></div><button className="ks-link" type="button" onClick={onReset}>{t("Reset password")}</button></div> : null}
      <div className="ks-row"><div className="ks-l"><b>{t("Type")}</b><span>{t(ROLE_NAMES[person.role])}</span></div></div>
      <div className="ks-row"><div className="ks-l"><b className="settings-danger">{t("Delete account_theAccount")}</b></div>
        <button
          className={`ks-link${onlyAdmin ? '' : ' settings-danger'}`}
          type="button"
          disabled={onlyAdmin}
          title={onlyAdmin ? t("It is the only admin account: the nest won’t delete it.") : undefined}
          onClick={onDelete}
        >
          {t("Delete")}
        </button>
      </div>
    </div>
  )
}

function NewAccount({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { serverUrl } = usePairing()
  const [label, setLabel] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const minted = await householdGateway().mintDevice({ label: label.trim(), role })
      setToken(minted.token)
      onCreated()
    } catch (error) {
      setProblem(isPairingError(error) && error.kind === 'rejected' ? t("That name is not valid") : t("Could not create the account"))
    } finally {
      setBusy(false)
    }
  }

  const link = token ? buildAccessLink(serverUrl, token) : null
  return (
    <Modal title={t("New account")} onClose={token ? () => {} : onClose} className={token ? 'settings-modal--qr' : undefined}>
      {token === null ? (
        <form
          className="settings-qr__side"
          onSubmit={(event) => {
            event.preventDefault()
            if (label.trim() !== '' && !busy) void create()
          }}
        >
          <label className="z-field">
            <span className="z-label">{t("Name")}</span>
            <input className="ks-field" value={label} maxLength={80} placeholder="Ana" onChange={(e) => setLabel(e.target.value)} />
          </label>
          <div className="z-field">
            <span className="z-label">
              <span className="settings-tipped" tabIndex={0} title={t("Chosen now and not changed later.")}>
                {t("Type")}
              </span>
            </span>
            <Seg<Role>
              label={t("Type")}
              value={role}
              onChange={setRole}
              options={[
                { value: 'member', label: t(ROLE_NAMES.member), title: t("Sees the nest’s library and has its own playlists") },
                { value: 'owner', label: t(ROLE_NAMES.owner), title: t("Can create and delete accounts, and change nest settings") },
              ]}
            />
          </div>
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
              {t("Create the account")}
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
                    <span>{bareHost(serverUrl)}</span>
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

function AccountRow({ person, own, children }: { person: PairedDevice; own: boolean; children: (devices: UseQueryResult<Awaited<ReturnType<typeof listAccountDevices>>>) => React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const devices = useQuery({
    queryKey: [...queryKeys.household.all, 'devices', { id: person.id }],
    queryFn: ({ signal }) => listAccountDevices(person.id, signal),
    staleTime: 60_000,
    enabled: open,
  })
  return <details className="settings-acc" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="ka-row">
      <Avatar person={person} />
      <span className="ks-l settings-acc__id">
        <b>{person.label}{own ? <span className="settings-here">{t("you")}</span> : null}</b>
        <span className="settings-acc__sub"><RoleWord role={person.role} />{devices.data ? <> · {t("{{n}} devices", { count: devices.data.length, n: devices.data.length })}</> : null} · {formatSeen(person.lastSeenAt)}</span>
      </span>
      <ChevronRight className="i settings-acc__chev" aria-hidden />
    </summary>
    {open ? children(devices) : null}
  </details>
}

export function Accounts(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { me } = useSettings()
  const accounts = useAccounts(true)
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null)
  const [deleting, setDeleting] = useState<PairedDevice | null>(null)
  const [resetting, setResetting] = useState<PairedDevice | null>(null)
  const [creating, setCreating] = useState(false)
  const ownId = me?.source === 'token' ? me.id : null
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.household.all })

  const rename = async (person: PairedDevice, label: string, undo: boolean) => {
    try {
      await renameAccount(person.id, label)
      setRenaming(null)
      refresh()
      toast(t("Name changed"), undo ? { undo: () => void rename({ ...person, label }, person.label, false) } : {})
    } catch {
      toast(t("Could not change the name"), { err: true })
    }
  }

  const list = accounts.data ?? []
  const admins = list.filter((person) => person.role === 'owner').length
  const sorted = [...list].sort((a, b) => Number(b.id === ownId) - Number(a.id === ownId))

  return (
    <Page id="cuentas">
      <div className="settings-block ks-group">
        <div className="settings-block__head">
          <h3 title={list.length === 1 ? t("Only your account is here.") : undefined}>{t("On this nest")}</h3>
          {accounts.data ? <span className="settings-count z-mono">{list.length}</span> : null}
          <button className="og-btn og-btn--go settings-head-act" type="button" onClick={() => setCreating(true)}>
            <Plus className="i" aria-hidden />
            {t("New account")}
          </button>
        </div>
        {accounts.isPending ? (
          <Skel rows={3} label={t("Loading the accounts")} />
        ) : accounts.isError ? (
          <QueryFailure error={accounts.error} what={t("the accounts")} onRetry={() => void accounts.refetch()} />
        ) : (
          <div className="settings-block__body">
            {sorted.map((person) => (
              <AccountRow person={person} own={person.id === ownId} key={person.id}>
                {devices => <>
                {renaming?.id === person.id ? (
                  <form
                    className="settings-inlineform settings-acc__body"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const next = renaming.draft.trim()
                      if (next !== '' && next !== person.label) void rename(person, next, true)
                    }}
                  >
                    <input
                      className="ks-field"
                      aria-label={t("Account name")}
                      value={renaming.draft}
                      maxLength={80}
                      autoFocus
                      onChange={(e) => setRenaming({ id: person.id, draft: e.target.value })}
                    />
                    <button className="ks-btn ks-btn--sm ks-btn--ghost" type="button" onClick={() => setRenaming(null)}>
                      {t("Cancel")}
                    </button>
                    <button className="ks-btn ks-btn--sm settings-ink" type="submit" disabled={renaming.draft.trim() === '' || renaming.draft.trim() === person.label}>
                      {t("Save")}
                    </button>
                  </form>
                ) : (
                  <AccountBody
                    person={person}
                    devices={devices}
                    onlyAdmin={person.role === 'owner' && admins <= 1}
                    onRename={() => setRenaming({ id: person.id, draft: person.label })}
                    onDelete={() => setDeleting(person)}
                    onReset={me?.source === 'token' && person.id !== ownId ? () => setResetting(person) : undefined}
                  />
                )}
                </>}
              </AccountRow>
            ))}

          </div>
        )}
      </div>
      {resetting && <ResetPassword id={resetting.id} label={resetting.label} onClose={() => setResetting(null)} />}
      {creating ? <NewAccount onClose={() => setCreating(false)} onCreated={refresh} /> : null}
      {deleting ? (
        <DeleteAccount key={deleting.id} person={deleting} own={deleting.id === ownId} onClose={() => setDeleting(null)} onDeleted={refresh} />
      ) : null}
    </Page>
  )
}
