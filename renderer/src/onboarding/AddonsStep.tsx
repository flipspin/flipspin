import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { refreshMac, useMacEngine } from '../lyrics/macEngine'
import { msg } from '../i18n'
import { Button } from '../ui/react/components/Button'
import { hasBridge, bridge } from '../bridge'
import { useCurrentUser } from '../data'
import { detectSurface } from '../settings/context'
import { WizardFrame } from './Shell'
import { installPickedAddons } from './installPickedAddons'
import './steps.css'

export type AddonId = 'lyrics' | 'stems' | 'analysis'

const ADDONS = [
  { id: 'lyrics', hue: 'yellow', name: msg("Lyrics_plural"), what: msg("Syncs your lyrics to the music."), size: msg("≈ 6 GB, shared with Stems"), runs: msg("on your computer (helper)"), runsTip: msg("Runs on this Mac, or any computer with “Process for the nest” on (Settings → Helpers). The nest only stores the result"), facts: [
    { label: "Alignment", value: msg("MMS_FA"), tip: msg("Lines a known lyric up with the voice: 8 s windows + 3 s context, our own Viterbi · CC BY-NC 4.0 licence, non-commercial") },
    { label: "Vocal isolation", value: msg("Demucs"), tip: msg("Separates the voice before syncing · MIT licence") },
    { label: "M1 Pro", value: msg("≈ 25 s per song"), tip: msg("Per ≈ 3:30 song, isolating the voice. If the song already has stems: ≈ 11 s. MacBook Pro with M1 Pro (2021)") },
    { label: "RTX 3060", value: msg("≈ 20 s per song"), tip: msg("Approximate, per ≈ 3:30 song · ≈ 3 GB of video memory") },
    { label: "Ryzen 5 5600", value: msg("≈ 4 min per song"), tip: msg("Approximate, CPU only, per ≈ 3:30 song, isolating the voice. If the song already has stems: ≈ 30 s") },
    { label: "Accuracy", value: msg("90.5 % of lines within 1 s"), tip: msg("Measured on 6 songs, against the real voice") },
  ] },
  { id: 'stems', hue: 'purple', name: msg("Stems"), what: msg("Splits vocals, drums, bass and other."), size: msg("≈ 6 MB per minute of music"), runs: msg("on your computer (helper)"), runsTip: msg("Same engine as Lyrics, on this Mac or any computer with “Process for the nest”. Stems are stored on the nest"), facts: [
    { label: "Separation", value: msg("htdemucs"), tip: msg("Vocals, drums, bass and other · MIT licence") },
    { label: "Beat tracking", value: msg("beat_this"), tip: msg("Beats and bars for the cuts; exact tempo on 83.5 % of GiantSteps (661 songs) · MIT licence") },
    { label: "M1 Pro", value: msg("≈ 18–22 s per song"), tip: msg("3:10 song, from request to ready, on a MacBook Pro with M1 Pro (2021) · peak ≈ 5.6 GB of memory") },
    { label: "Ryzen 5 5600", value: msg("≈ 2.5 min per song"), tip: msg("Approximate, CPU only, 3:10 song · ≈ 2 GB of memory") },
    { label: "RTX 3060", value: msg("≈ 20 s per song"), tip: msg("Approximate, 3:10 song · ≈ 3–7 GB of video memory") },
    { label: "Output", value: msg("4 × Opus 192 kb/s"), tip: msg("Cut by bar, with the key; ≈ 5.7 MB per minute of music") },
  ] },
  { id: 'analysis', hue: 'amber', name: msg("Analysis"), what: msg("Key, BPM and mood of each song."), size: msg("≈ 100 MB, without the engine"), runs: msg("on your computer (helper)"), runsTip: msg("Processed on this Mac, or any computer with “Process for the nest” enabled. The nest stores the key and BPM of each song"), facts: [
    { label: "Key", value: msg("KeyFinder"), tip: msg("Whole-song key · 73% exact in the test (60 electronic songs from GiantSteps) · GPL-3.0 license") },
    { label: "Tempo", value: msg("TempoCNN"), tip: msg("Whole-song BPM · 95% exact in the same test · AGPL-3.0 weights, in ONNX") },
    { label: "M1 Pro", value: msg("≈ 1 s per song"), tip: msg("Measured: 3:30 song, one thread, MacBook Pro with M1 Pro (2021)") },
    { label: "Ryzen 5 5600", value: msg("≈ 2 s per song"), tip: msg("Approximate, CPU only, one thread, 3:30 song") },
    { label: "Accuracy", value: msg("key 73 % · BPM 95 %"), tip: msg("Exact on 60 GiantSteps electronic songs; other genres may miss more") },
  ] },
] as const

export interface AddonsStepProps {
  host: React.ReactNode
  initialPicked?: AddonId[]
  onBack: () => void
  onDone: (picked: AddonId[]) => void
}

export function AddonsStep({ host, onBack, onDone, initialPicked = [] }: AddonsStepProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const engine = useMacEngine()
  const me = useCurrentUser()
  const desktop = detectSurface() === 'app' && hasBridge()
  const status = engine.status
  const [picked, setPicked] = useState<AddonId[]>(initialPicked)
  const [lyricsAcknowledged, setLyricsAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const finished = useRef(false)
  useEffect(() => {
    if (!desktop) return
    void refreshMac()
    const offProgress = bridge().on('lyrics:engine-progress', () => { void refreshMac() })
    const offWorker = bridge().on('lyrics:worker-changed', () => { void refreshMac() })
    return () => { offProgress(); offWorker() }
  }, [desktop])
  const memory = status?.hardware?.memoryBytes
  const noJobs = status?.hardware?.jobs?.length === 0
  const reason = !desktop ? t("Start it from the desktop app on the computer.")
    : !status ? t("Checking this computer…")
    : !status.supported ? t("Not available on this system")
    : noJobs ? t("This computer cannot do any of these jobs")
    : !status.eligible ? t("This computer already hosts the nest")
    : !me.data?.isOwner || me.data.source !== 'token' ? t("Only an admin account can process for the nest") : null
  const memoryReason = memory != null && memory < 8 * 2 ** 30 ? t("Needs 8 GB of memory · this computer has {{n}} GB", { n: Number((memory / 2 ** 30).toFixed(1)).toLocaleString(i18n.language) }) : null
  const reasonFor = (id: AddonId) => reason || (id !== 'analysis' ? memoryReason : null)

  function finish(value: AddonId[]) {
    if (finished.current) return
    finished.current = true
    onDone(value)
  }
  async function start() {
    if (busy || finished.current || picked.includes('lyrics') && !lyricsAcknowledged) return
    const available = picked.filter(id => !reasonFor(id))
    if (!available.length) { finish([]); return }
    setBusy(true)
    setProblem(null)
    try {
      await installPickedAddons(available)
      finish(available)
    } catch {
      setProblem(t("The engine could not start. You can continue and retry in Settings → Engines."))
    } finally { setBusy(false) }
  }

  return <WizardFrame {...{ wide: true }} step="addons" host={host} title={t("Engines")} show={null}
    back={<Button className="kob-btn kob-btn--ghost" variant="ghost" disabled={busy} onClick={onBack}>{t("Back")}</Button>}
    actions={<>
      <Button className="kob-btn" title={t("Also in Settings → Engines")} onClick={() => finish([])}>{t("Skip")}</Button>
      <Button className="kob-btn kob-btn--coral" variant="primary" loading={busy} disabled={picked.includes('lyrics') && !lyricsAcknowledged} onClick={() => { if (problem) finish([]); else void start() }}>{t("Next")}</Button>
    </>}
  >
    <div className="kob-addons">
      <div className="kob-addons-grid">
        {ADDONS.map(addon => <div key={addon.id} className={`kob-option kob-addon${picked.includes(addon.id) ? ' is-picked' : ''}`}>
          <label className="kob-option-head" title={reasonFor(addon.id) ?? undefined}>
            <span className={`kob-dot kob-addon-dot--${addon.hue}`} aria-hidden="true" />
            <b>{t(addon.name)}</b>
            <input type="checkbox" aria-label={t("Install {{name}}", { name: t(addon.name) })} checked={picked.includes(addon.id)} disabled={!!reasonFor(addon.id) || busy} onChange={event => { setProblem(null); setPicked(values => event.target.checked ? [...values, addon.id] : values.filter(id => id !== addon.id)) }} />
          </label>
          <p>{t(addon.what)}</p>
          {addon.id === 'lyrics' ? <span className="kob-mono">CC BY-NC 4.0 · {t("non-commercial")}</span> : null}
          {addon.id === 'lyrics' && picked.includes('lyrics') ? <label className="kob-option-head"><input type="checkbox" checked={lyricsAcknowledged} disabled={busy} onChange={event => setLyricsAcknowledged(event.target.checked)} />{t("I'll use it only for non-commercial purposes")}</label> : null}
          <dl className="kob-specs">{addon.facts.map(fact => <div className="kob-spec" key={fact.label}><dt>{fact.label}</dt><dd className="kob-specs__v" title={t(fact.tip)}>{t(fact.value)}</dd></div>)}</dl>
          <div className="kob-addon-footer kob-mono kob-muted"><span title={t("Space it takes once installed")}>{t(addon.size)}</span><span aria-hidden="true"> · </span><span title={t(addon.runsTip)}>{t(addon.runs)}</span></div>
          {problem && picked.includes(addon.id) && <div className="kob-alert" role="alert">{problem}<Button className="kob-btn kob-btn--sm" size="sm" onClick={() => void start()}>{t("Retry")}</Button></div>}
        </div>)}
        <div className="kob-option kob-option--soon kob-addon" title={t("Data from MusicBrainz and Wikidata · runs on the nest")}>
          <div className="kob-option-head"><span className="kob-dot is-off" aria-hidden="true" /><b>{t('Ties')}</b><small>{t("Coming soon")}</small></div>
          <p>{t("Who sampled whom: the connections between your songs.")}</p>
        </div>
        <div className="kob-option kob-option--soon kob-addon" title={t("Comes after this release")}>
          <div className="kob-option-head"><span className="kob-dot is-off" aria-hidden="true" /><b>{t("Recommendations")}</b><small>{t("Coming soon")}</small></div>
          <p>{t("New music based on your library.")}</p>
        </div>
      </div>
      <span className="kob-muted">{t("Also in Settings → Engines.")}</span>
    </div>
  </WizardFrame>
}
