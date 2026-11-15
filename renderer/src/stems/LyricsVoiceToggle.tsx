import { useEffect, useRef, useState } from 'react';
import { AudioLines, Layers, Mic, MicOff, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { msg } from '../i18n';
import { Popover } from '../ui/react/components/Popover';
import { STEMS, type Mix } from './mix';
import { useStemPlayer } from './useStemPlayer';
import { useStemSong } from './useStemSong';
import type { StemEngine } from './stemEngine';
import { trackKey, type StemTrack } from './stemApi';
import './lyrics-voice.css';

const modes = [
  { preset: 'original', label: msg('Original'), tip: msg("With vocals"), Icon: AudioLines, level: 100 },
  { preset: 'karaoke', label: msg('Karaoke'), tip: msg("No vocals"), Icon: MicOff, level: 0 },
  { preset: 'vocals20', label: msg("Voice 20 %"), tip: msg("Quiet vocals to help you follow the melody"), Icon: Mic, level: 20 },
] as const;
type Preset = typeof modes[number]['preset'];
type SplitPreset = Exclude<Preset, 'original'>;
function voicePreset(mix: Mix) {
  return modes.findIndex(mode => !mix.muted.size && !mix.solo.size && STEMS.every(stem => mix.levels[stem] === (stem === 'vocals' ? mode.level : 100)));
}

type Props = {
  track: StemTrack | null;
  visible?: boolean;
  playingThis?: boolean;
  engine: StemEngine;
  onOpenAddons: () => void;
};
export default function LyricsVoiceToggle(props: Props) {
  // Neither an open confirmation nor an auto-play intent belongs to the next song.
  return <SongVoiceToggle key={props.track ? trackKey(props.track) : 'none'} {...props} />;
}

function SongVoiceToggle({ track, visible = true, playingThis = true, engine, onOpenAddons }: Props) {
  const { t } = useTranslation();
  const player = useStemPlayer();
  const { setPreset } = player;
  const song = useStemSong(track, visible);
  const intent = useRef<SplitPreset | null>(null);
  const [picked, setPicked] = useState<SplitPreset>('karaoke');
  const [asking, setAsking] = useState<SplitPreset | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const confirm = useRef<HTMLButtonElement | null>(null);
  const ready = song.data?.ready;
  const pending = song.data?.pending;
  const failed = !ready && (pending?.status === 'failed' || song.request.isError);
  const splitting = !ready && (song.request.isPending || Boolean(pending && pending.status !== 'failed'));
  const progress = Math.round(Math.max(0, Math.min(100, pending?.progress ?? 0)));
  const selected = ready ? voicePreset(player.mix) : 0;
  const panelOpen = Boolean(asking && visible && playingThis && !ready && !splitting);
  useEffect(() => {
    if (!intent.current || !ready || !playingThis) return;
    const preset = intent.current;
    intent.current = null;
    setPreset(preset);
  }, [ready, playingThis, setPreset]);
  useEffect(() => {
    if (!visible || !playingThis || ready || splitting) setAsking(null);
  }, [visible, playingThis, ready, splitting]);

  const choose = (preset: Preset, button: HTMLButtonElement) => {
    if (ready || preset === 'original') {
      intent.current = null;
      setAsking(null);
      setPreset(preset);
    } else if (splitting) {
      intent.current = preset;
      setPicked(preset);
    } else {
      anchor.current = button;
      setAsking(preset);
    }
  };
  const details = [engine.machine, engine.backend, engine.estimate != null ? t('≈ {{n}} s', { n: engine.estimate }) : null].filter(Boolean).join(' · ');
  const reason = pending?.error || (song.request.error instanceof Error ? song.request.error.message : undefined);
  return <>
    <div className={`lx-seg${selected < 0 || !playingThis ? ' is-none' : ''}`} role="radiogroup" aria-label={t("Vocals")}>
      <span className="lx-seg__thumb" style={{ transform: `translateX(${Math.max(0, selected) * 100}%)` }} aria-hidden />
      {modes.map(({ preset, label, tip, Icon }, i) => {
        const working = splitting && picked === preset;
        const retry = failed && picked === preset;
        return <div className={`lx-seg__option${working ? ' is-working' : ''}`} key={preset}>
          {working && <span className="lx-seg__fill" role="progressbar" aria-label={t("Splitting")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} style={{ width: `${progress}%` }} />}
          <button type="button" role="radio" title={retry ? reason : t(tip)} aria-label={t(label)} aria-checked={playingThis && selected === i} tabIndex={selected === i || (selected < 0 && i === 0) ? 0 : -1}
            aria-haspopup={preset !== 'original' && !ready ? 'dialog' : undefined} aria-expanded={preset !== 'original' && !ready ? panelOpen && asking === preset : undefined}
            className={`${playingThis && selected === i ? 'is-on' : ''}${panelOpen && asking === preset ? ' is-asking' : ''}`} disabled={!track || !playingThis}
            onClick={e => choose(preset, e.currentTarget)} onKeyDown={e => {
              if (e.key === 'Tab' && !e.shiftKey && panelOpen) { e.preventDefault(); confirm.current?.focus(); return; }
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
              const button = e.currentTarget.closest('[role="radiogroup"]')?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next];
              if (button) { button.focus(); choose(modes[next].preset, button); }
            }}><Icon aria-hidden /><span aria-live={working || retry ? 'polite' : undefined}>{working ? t("Splitting · {{progress}} %", { progress }) : retry ? t("Try again_retryAlternate") : t(label)}</span></button>
          {working && <button type="button" className="lx-seg__cancel" aria-label={t("Cancel split")} title={t("Cancel split")} disabled={song.cancel.isPending || song.request.isPending} onClick={() => {
            intent.current = null;
            song.cancel.mutate();
          }}><X aria-hidden /></button>}
        </div>;
      })}
    </div>
    <Popover open={panelOpen} onClose={() => setAsking(null)} anchorRef={anchor} initialFocus="none" className="lx-ask" aria-label={t("This song isn't split yet")}>
      <div className="lx-ask__heading">{t("This song isn't split yet")}</div>
      {engine.available && details && <div className="lx-ask__details">{details}</div>}
      <button ref={confirm} type="button" className="lx-ask__confirm" title={!engine.available ? t("Needs the Stems add-on · opens Settings → Engines") : details} onClick={() => {
        if (!panelOpen || !asking) return;
        setAsking(null);
        if (!engine.available) { onOpenAddons(); return; }
        intent.current = asking;
        setPicked(asking);
        song.request.mutate(undefined, { onError: () => { intent.current = null; } });
      }}><Layers aria-hidden />{asking === 'vocals20' ? t("Split and play with voice 20 %") : t("Split and play karaoke")}{!engine.available && <> <span className="lx-ask__pill">{t("Add-on")}</span></>}</button>
    </Popover>
    {song.cancel.isError && <span role="alert">{t("Could not complete the action. Try again._repeat")}</span>}
  </>;
}
