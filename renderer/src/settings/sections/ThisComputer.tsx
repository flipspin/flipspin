/** Keep language, appearance and offline lyrics local to this device or browser session. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'

import { LANGUAGE_CHOICE, LANGUAGE_NAMES, SHIPPED_LANGUAGES, currentLanguage, msg, setLanguage, type Language } from '../../i18n'
import { useVolumeLevelling, setVolumeLevelling } from '../../player/volumeLevelling'
import { useDeviceName } from '../useDeviceName'
import { SEARCH_SHORTCUT_LABEL } from '../../lib/searchShortcutLabel'
import { resolveLocalLyrics, setLocalLyricsEnabled, useLocalLyrics } from '../../lyrics/lyricsStore'
import { useSettings } from '../context'
import { Modal, Seg, Switch, Tipped, Word, useToast } from '../parts'
import { Page } from './Head'
import { KeepAwakeSwitch } from '../../uploads/KeepAwakeSwitch'
import { ComputerPreferences } from './ComputerProcessing'

const MODES = [
  { value: 'light', label: msg("Light") },
  { value: 'dark', label: msg("Dark") },
  { value: 'night', label: msg("Night") },
] as const

const KEYS: readonly { keys: string[]; does: string }[] = [
  { keys: [msg("Space")], does: msg("Play / pause") },
  { keys: ['A', 'B'], does: msg("Previous · next") },
  { keys: [SEARCH_SHORTCUT_LABEL], does: msg("Search") },
  { keys: ['L'], does: msg("Lyrics") },
  { keys: ['D'], does: msg("Visualizer") },
  { keys: ['← →'], does: msg("±5 s in the lyric") },
]

function VolumeLevelling(): React.JSX.Element {
  const { t } = useTranslation()
  const levelling = useVolumeLevelling()
  return (
    <div className="settings-block ks-group"><div className="settings-block__body">
      <div className="z-props z-props--lined settings-props">
        <div className="z-prop">
          <span className="z-prop__label">{t("Volume levelling")}</span>
          <div className="z-prop__control">
            <Seg label={t("Volume levelling")} value={levelling}
              options={[{ value: 'auto', label: t("Auto") }, { value: 'track', label: t("Song") }, { value: 'album', label: t("Album") }, { value: 'off', label: t("Off_disabled") }]}
              onChange={setVolumeLevelling} />
          </div>
          <span className="z-prop__aux" />
        </div>
      </div>
    </div></div>
  )
}

function Aspecto(): React.JSX.Element {
  const { t } = useTranslation()
  const { host } = useSettings()
  const [language, setLang] = useState<Language>(currentLanguage())
  return (
    <div className="settings-block ks-group">
      <div className="settings-block__head">
        <h3>{t("Appearance")}</h3>
      </div>
      <div className="settings-block__body">
        <div className="z-props z-props--lined settings-props">
          {LANGUAGE_CHOICE ? <div className="z-prop">
            <span className="z-prop__label">{t("Language")}</span>
            <div className="z-prop__control">
              <Seg
                label={t("Language")}
                value={language}
                options={SHIPPED_LANGUAGES.map((lng) => ({ value: lng, label: LANGUAGE_NAMES[lng] }))}
                onChange={(lng) => {
                  setLanguage(lng)
                  setLang(lng)
                }}
              />
            </div>
            <span className="z-prop__aux" />
          </div> : null}
          <div className="z-prop">
            <span className="z-prop__label">{t("Mode")}</span>
            <div className="z-prop__control">
              <Seg
                label={t("Mode")}
                value={(MODES.some((m) => m.value === host.mode) ? host.mode : 'light') as (typeof MODES)[number]['value']}
                options={MODES.map((m) => ({ value: m.value, label: t(m.label) }))}
                onChange={host.setMode}
              />
            </div>
            <span className="z-prop__aux" />
          </div>
        </div>
      </div>
    </div>
  )
}

function download(path: string, text: string, synced: boolean): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${path.split('/').pop() ?? 'letra'}.${synced ? 'lrc' : 'txt'}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function OfflineLyrics(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const local = useLocalLyrics()
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [dropping, setDropping] = useState<string | null>(null)
  const pending = local.rows.filter((row) => row.pending)
  const conflicts = pending.filter((row) => row.status === 'conflict')

  const flip = async (next: boolean) => {
    setBusy(true)
    try {
      await setLocalLyricsEnabled(next)
      toast(next ? t("Offline lyrics on") : t("Offline lyrics off"), {
        undo: () => void setLocalLyricsEnabled(!next),
      })
    } catch (error) {
      toast(error instanceof Error ? t(error.message) : t("Could not change it"), { err: true })
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (path: string, keepLocal: boolean) => {
    setBusy(true)
    try {
      await resolveLocalLyrics(path, keepLocal)
      toast(keepLocal ? t("Your lyric is uploaded") : t("The nest’s lyric is used"))
    } catch (error) {
      toast(error instanceof Error ? error.message : t("Could not save your choice"), { err: true })
    } finally {
      setBusy(false)
      setDropping(null)
    }
  }

  return (
    <div className="settings-block ks-group">
      <div className="settings-block__head">
        <h3>{t("Offline lyrics")}</h3>
        <div className="ks-tools">
          {local.enabled ? conflicts.length ? <button className="ks-link" type="button" onClick={() => setReviewing(true)}><Word tone="warn">{t("{{n}} changes not uploaded", { count: pending.length, n: pending.length })}</Word></button> : <Word tone={pending.length ? 'warn' : 'ok'}>{pending.length ? t("{{n}} changes not uploaded", { count: pending.length, n: pending.length }) : t("All uploaded")}</Word> : null}
        <Switch
          label={t("Offline lyrics")}
          title={t("Keeps the lyrics you open on this computer; changes go up to the nest when it answers.")}
          checked={local.enabled}
          disabled={busy}
          onChange={(next) => void flip(next)}
        />
        </div>
      </div>
      {reviewing ? (
        <Modal title={t("Offline lyrics")} onClose={() => setReviewing(false)}>
          <div className="settings-sync">
            {conflicts.map((row) => (
              <div className="settings-conflict" key={row.path}>
                <span className="settings-conflict__song" title={t("The lyric also changed on the nest")}>
                  <b>{row.doc?.title || row.path.split('/').pop()}</b>
                  {row.doc?.artist ? ` · ${row.doc.artist}` : ''}
                </span>

                <span className="settings-conflict__do">
                  <button className="ks-btn ks-btn--sm" type="button" disabled={busy} onClick={() => void resolve(row.path, true)}>
                    {t("Use mine")}
                  </button>
                  <button className="ks-btn ks-btn--sm" type="button" disabled={busy} onClick={() => setDropping(row.path)}>
                    {t("Use the nest’s")}
                  </button>
                  <button
                    className="ks-btn ks-btn--sm ks-btn--ghost ks-btn--icon"
                    type="button"
                    title={t("Download your copy")}
                    aria-label={t("Download your copy")}
                    onClick={() => download(row.path, row.pending?.text ?? row.doc?.text ?? '', row.doc?.kind === 'synced')}
                  >
                    <Download className="i" aria-hidden />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
      {dropping ? (
        <Modal title={t("Use the nest’s lyric?")} onClose={() => setDropping(null)}>

          <div className="settings-modal__do">
            <button className="ks-btn" type="button" onClick={() => setDropping(null)}>
              {t("Cancel")}
            </button>
            <button title={t("Your version of these lyrics will be lost.")} className="ks-btn ks-btn--danger" type="button" onClick={() => void resolve(dropping, false)}>
              {t("Use the nest’s")}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

function Atajos(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="settings-block ks-group">
      <div className="settings-block__head">
        <h3 title={`${t("Close")}: Esc · ${t("Lock the tilt")}: Ctrl`}>{t("Shortcuts")}</h3>
      </div>
      <div className="settings-block__body settings-keys">
        {KEYS.map((row) => (
          <span className="settings-key" key={row.does}>
            <span>{t(row.does)}</span><span className="settings-key__caps">
            {row.keys.map((key) => (
              <span className="z-kbd" key={key}>
                {t(key)}
              </span>
            ))}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

export function ThisComputer(): React.JSX.Element {
  const { surface } = useSettings()
  const name = useDeviceName()
  return (
    <Page id="equipo" sub={name ?? undefined}>
      <ComputerPreferences />
      <Aspecto />
      <VolumeLevelling />
      {surface === 'app' && <div className="settings-block ks-group"><KeepAwakeSwitch settings /></div>}
      <OfflineLyrics />
      {surface === 'app' ? <Atajos /> : null}
    </Page>
  )
}
