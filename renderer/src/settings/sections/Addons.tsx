import { useSplits } from '../../stems/useStemSong'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AudioWaveform, Cpu, Layers, MicVocal } from 'lucide-react'
import { refreshMac, useMacEngine } from '../../lyrics/macEngine'
import { refreshJobs, useLyricsJobs, useLyricsJobsError, useLyricsJobsFailure, watchJobs } from '../../lyrics/lyricsStore'
import { GpuAcceleration } from './GpuAcceleration'
import { AnalysisAddon } from './AnalysisAddon'
import { AddonCard, AddonRow, AddonSize } from './AddonCard'
import { useSettings } from '../context'
import { useConfig } from '../config'
import { useExtensions, useLibrarySummary, useServerStorage } from '../data'
import { formatBytes, formatCount } from '../format'
import { helperKind, helperKindTip, helperSpeed } from '../helper'
import { ErrorAlt, QueryFailure, Skel, Switch, Word } from '../parts'
import { Page } from './Head'
import { useDeviceName } from '../useDeviceName'
import { useAddonControls } from './useAddonControls'
import { Sheet } from '../background/controls'
import '../background/background-work.css'
import { engineWord, installFailure } from '../engine'
import { Missing } from '../../ui/react/components/Missing'
import { missingWord } from '../../ui/react/components/missingWords'

export function Addons(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { admin, surface, go } = useSettings()
  const extensions = useExtensions(admin === true)
  const management = useAddonControls()
  const { computer, status, unavailable, engineReady, engineInstalling, prerequisite, act, busy } = management
  const mac = useMacEngine()
  const name = useDeviceName()
  const jobs = useLyricsJobs()
  const jobsError = useLyricsJobsError()
  const jobsFailure = useLyricsJobsFailure()
  const summary = useLibrarySummary(admin === true)
  const storage = useServerStorage(admin === true)
  const { query: config } = useConfig()
  const splits = useSplits(admin === true)
  useEffect(() => admin ? watchJobs() : undefined, [admin])
  const installing = status?.installing
  const engineError = status?.installError
  const addons = status?.addons
  const engineTooSmall = management.memory != null && management.memory < 8 * 2 ** 30
  const engineRemovalBlocked = !!addons && [addons.lyrics, addons.stems].some(addon => addon?.installed)
  const lyricsEngine = engineWord(jobs?.engine)
  const lyricsPaused = management.compute.data?.paused || management.compute.data?.kinds.find(kind => kind.kind === 'align')?.policy.paused
  const stemsKind = management.compute.data?.kinds.find(kind => kind.kind === 'stems')
  const background = stemsKind ? stemsKind.policy.libraryPass === 'auto' : config.data?.groups.flatMap(g => g.settings).find(r => r.key === 'KROBI_STEMS_BACKGROUND')?.value === true
  return <Page id="complementos">
    <div className="cx-host"><span>{t("This computer: {{name}}", { name: computer?.facts?.name || name || missingWord('nodata') })}</span><code>{computer?.hardware || <Missing kind="nodata" />}</code>
      {computer?.status.enabled && !installing && computer && !unavailable ? <Word tone={computer.tone} title={computer.statusTip}>{t("Processing for the nest · {{state}}", { state: computer.issue ? computer.state : computer.connected ? t(computer.word.word) : t("Offline") })}</Word> : null}
      {computer && admin === true ? <button type="button" className="ks-link" onClick={() => go('equipos')}>{t("Helpers_helpers")}</button> : null}
    </div>
    {surface === 'app' && !computer ? mac.lastError ? <ErrorAlt what={t("this device")} onRetry={() => void refreshMac()} /> : <Skel rows={3} /> : null}
    <section className="settings-block ks-group">
      <div className="ks-row"><b title={t("This computer runs the engines for everyone in the nest")}>{t("Help the nest")}</b><Switch label={t("Help the nest")} checked={!!status && 'enabled' in status && status.enabled === true} disabled={busy || !!unavailable || !status?.installed || admin !== true} onChange={enabled => void management.help(enabled)} /></div>
      <div className="ks-row"><b title={t((management.memory ?? Infinity) < 8 * 2 ** 30 ? "Analysis" : "Engine · Analysis · Stems")}>{t("Install everything this computer can run")}</b><Switch label={t("Install everything this computer can run")} checked={management.everything} disabled={busy || !!unavailable || !status || !management.own || admin !== true} onChange={value => void management.installAll(value)} /></div>
    </section>
    <AddonCard name={t("Engine_short")} kind={t("Built-in")} icon={Cpu} accent="coral" engineState={engineInstalling ? 'installing' : engineReady ? 'ready' : 'uninstalled'}>
      <AddonRow label={t("On this computer_device")} size={<AddonSize bytes={status?.sizeBytes} installed={status?.installed === true} estimate={1_300_000_000} details={t("Python and shared dependencies · excludes models and Analysis-only packages")} />} value={t('Python · torch / MLX')} mono
        state={<Word tone={engineError ? 'bad' : engineInstalling ? 'warn' : engineReady ? 'ok' : 'off'} title={engineError || unavailable || undefined}>{unavailable ? t("Unavailable") : engineError ? t(installFailure(engineError, 'engine')) : engineInstalling ? t("Installing") : engineReady ? t("Installed") : t("Not installed")}</Word>}
        actions={<><button type="button" className="ks-btn" disabled={admin !== true || !!unavailable || !status || busy || !!installing || (!status.installed && engineTooSmall) || (engineReady && !engineError && engineRemovalBlocked)} title={engineRemovalBlocked ? t("Remove Lyrics and Stems first") : engineTooSmall ? t("needs 8 GB") : unavailable || undefined} onClick={() => void act('engine', engineReady && !engineError)}>{engineError ? t("Repair") : engineReady ? t("Remove") : status?.installed ? t("Repair") : t("Install")}</button>{status?.installed && (!engineReady || engineError) ? <button type="button" className="ks-link" disabled={!!unavailable || busy || !!installing || engineRemovalBlocked} title={engineRemovalBlocked ? t("Remove Lyrics and Stems first") : undefined} onClick={() => void act('engine', true)}>{t("Remove")}</button> : null}</>} />
      {engineInstalling ? <div className="cx-prog"><div className="z-meter" role="progressbar" aria-label={t("Installing the engine…")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={installing?.percent ?? undefined}><i style={{ width: `${installing?.percent ?? 0}%` }} /></div><span>{computer?.phase}</span></div> : null}
      <GpuAcceleration management={management} />
    </AddonCard>
    {(['letras', 'stems'] as const).map(id => {
      const lyrics = id === 'letras'
      const target = lyrics ? 'lyrics' : 'stems'
      const addon = addons?.[target]
      const addonInstalling = addon?.installing || installing?.target === target
      const addonError = addon?.error
      const ready = addon?.ready === true
      const installed = addon?.installed === true
      const tooSmall = management.memory != null && management.memory < 8 * 2 ** 30
      const useKind = lyrics ? 'align' : 'stems'
      const Icon = lyrics ? MicVocal : Layers
      const speed = helperSpeed(computer?.worker ?? null, lyrics ? 'align' : 'stems')
      const facts = [lyrics ? t("MMS aligner · demucs") : t('htdemucs · beat_this'), computer?.accel ? [t(helperKind(computer.accel)), computer.accel === 'cuda' ? computer.facts?.gpu : null].filter(Boolean).join(' · ') : null, speed.value !== null ? t('{{n}} s/min', { n: speed.value.toLocaleString(i18n.language, { maximumFractionDigits: 1 }) }) : null].filter(Boolean).join(' · ')
      // Lyrics' row only counts songs with a lyric: searching the catalogs is not the add-on (its switch is in Settings → Lyrics).
      const nestOn = !lyrics && background
      const nestError = lyrics ? jobsError || summary.isError : splits.isError || storage.isError
      const nestReady = lyrics ? jobs && summary.data : splits.data && storage.data
      return <AddonCard key={id} name={lyrics ? t("Lyrics_plural") : t('Stems')} kind={t("Built-in")} icon={Icon} accent={lyrics ? 'purple' : 'teal'}
        description={lyrics ? t("Sync lyrics") : t("Split vocals, drums, bass and other")}
        disabled={admin !== true} disabledTitle={admin !== true ? t("Admins only") : undefined} onOpen={() => go(id)} engineState={unavailable ? 'unavailable' : addonInstalling ? 'installing' : ready ? 'ready' : installed ? 'models-missing' : 'uninstalled'}>
        <AddonRow extension={admin === true ? extensions.data?.extensions.find(item => item.kind === 'engine' && item.id === target) : undefined} label={t("In the nest")} value={admin !== true ? <Missing kind="noAccess" /> : nestReady ? lyrics ? t("{{n}} of {{total}} with lyrics", { n: formatCount(jobs!.withLyrics), total: formatCount(summary.data!.songs) }) : t("{{n}} songs with stems · {{size}}", { count: splits.data!.splits.length, n: formatCount(splits.data!.splits.length), size: formatBytes(storage.data!.stems) }) : <Missing kind={nestError ? 'nodata' : 'loading'} />}
          state={lyrics && admin === true && !nestError && nestReady ? <Word tone={lyricsPaused ? 'off' : lyricsEngine?.tone ?? 'off'}>{lyricsPaused ? t("Paused") : lyricsEngine ? t(lyricsEngine.word) : <Missing kind="nodata" />}</Word> : <Word tone={nestError ? 'bad' : nestReady && nestOn ? 'ok' : 'off'} title={admin !== true ? t("Admins only") : undefined}>{admin !== true ? t("Unavailable") : nestError ? t("Offline") : nestReady ? t(background ? "Running" : "Off") : t("Loading")}</Word>} />
        {admin === true && nestError ? <QueryFailure error={lyrics ? jobsError ? jobsFailure : summary.error : splits.error || storage.error} what={lyrics ? t("the library’s lyrics") : t("stems")} onRetry={() => { if (lyrics) { void refreshJobs(); void summary.refetch() } else { void splits.refetch(); void storage.refetch() } }} /> : null}
        <AddonRow label={t("On this computer_device")} size={<AddonSize bytes={addon?.sizeBytes} installed={installed} estimate={lyrics ? 1_200_000_000 : 100_000_000} details={lyrics ? t("MMS aligner · CC BY-NC 4.0 licence, non-commercial use") : 'beat_this'} shared={{ bytes: addon?.sharedBytes, with: lyrics ? t('Stems') : t("Lyrics_plural") }} />} value={<>{facts}{lyrics ? <span className="bw-license" title={t("MMS aligner · CC BY-NC 4.0 licence, non-commercial use")}>{t('CC BY-NC 4.0')}</span> : null}</>} mono title={[computer?.accel ? t(helperKindTip(computer.accel)) : null, speed.value === null ? t("Not measured on this computer yet") : null].filter(Boolean).join(' · ')}
          state={<Word tone={addonError ? 'bad' : addonInstalling ? 'warn' : ready ? 'ok' : 'off'} title={addonError || unavailable || undefined}>{unavailable ? t("Unavailable") : addonError ? t(installFailure(addonError, target)) : addonInstalling ? t("Installing") : ready ? t("Installed") : installed ? t("models missing") : t("Not installed")}</Word>}
          actions={<><label className="cx-use"><input type="checkbox" aria-label={t("Use {{addon}}", { addon: lyrics ? t("Lyrics_plural") : t('Stems') })} checked={management.own?.limits.use?.[useKind] !== false} disabled={busy || !ready || !management.own || admin !== true} onChange={event => management.use(useKind, event.target.checked)} />{t("Use")}</label><button type="button" className="ks-btn" disabled={admin !== true || !!unavailable || !status || busy || !!installing || (!installed && (tooSmall || !!prerequisite))} title={tooSmall ? t("needs 8 GB") : prerequisite || unavailable || undefined} onClick={() => void act(target, installed && ready && !addonError)}>{addonError || (installed && !ready) ? t("Repair") : ready ? t("Remove") : t("Install")}</button>{installed && !ready ? <button type="button" className="ks-link" disabled={busy || !!installing} onClick={() => void act(target, true)}>{t("Remove")}</button> : null}</>} />
        {addonInstalling ? <div className="cx-prog"><div className="z-meter" role="progressbar" aria-label={t("Downloading models…")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={installing?.percent ?? undefined}><i style={{ width: `${Math.max(0, Math.min(100, installing?.percent ?? 0))}%` }} /></div><code>{t("Downloading models…")}{installing?.percent != null ? ` · ${installing.percent} %` : ''}</code></div> : null}
      </AddonCard>
    })}
    <AnalysisAddon management={management} />
    <div className="cx-coming">
    <AddonCard name={t("Beat grid")} kind={t("Coming soon")} icon={AudioWaveform} />
    </div>
    <Sheet open={management.consent} title={t("Install Lyrics sync?")} onClose={() => management.setConsent(false)}>
      <div className="ks-row"><b>{t("Size")}</b><AddonSize bytes={addons?.lyrics?.sizeBytes} installed={addons?.lyrics?.installed === true} estimate={1_200_000_000} details={t("MMS aligner · demucs")} /></div>
      <div className="ks-row"><b title="MMS forced aligner (Meta)">{t("Model licence")}</b><span className="bw-license">{t("CC BY-NC 4.0 · non-commercial")}</span></div>
      <label className="ks-row bw-consent"><input type="checkbox" checked={management.acknowledged} onChange={event => management.setAcknowledged(event.target.checked)} />{t("I'll use it only for non-commercial purposes")}</label>
      <div className="bw-footer"><button className="ks-link" type="button" onClick={() => management.setConsent(false)}>{t("Cancel")}</button><button className="ks-btn ks-btn--go" type="button" disabled={!management.acknowledged || busy} onClick={management.confirmLyrics}>{t("Install Lyrics sync")}</button></div>
    </Sheet>
  </Page>
}
