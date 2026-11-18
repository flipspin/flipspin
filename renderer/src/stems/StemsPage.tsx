import { useRef, useState, type CSSProperties } from 'react';
import { Layers, MoreHorizontal, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentUser } from '../data/hooks/use-current-user';
import { apiDelete, queryKeys, type ApiData } from '../data';
import { useToast } from '../settings/parts';
import { splitKey, useSplitDeletes } from '../settings/splitDeletes';
import { msg } from '../i18n';
import { effectiveGain, isOriginal, STEMS } from './mix';
import type { StemTrack } from './stemApi';
import { useStemPlayer } from './useStemPlayer';
import { useStemSong } from './useStemSong';
import { stemPlayer } from './StemPlayer';
import Fader, { FaderScales } from './Fader';
import { Popover } from '../ui/react/components/Popover';
import './stems.css';

const channels = {
  drums: { name: msg("Drums"), hue: '#F2C24C' }, bass: { name: msg("Bass"), hue: '#3E6FD0' },
  other: { name: msg("Other"), hue: '#2F9C86' }, vocals: { name: msg("Vocals"), hue: '#8A74D8' },
};
const phases = { decoding: msg("decode"), beats: msg("beats"), separating: msg("split"), chops: msg("slice"), encoding: msg("encode"), uploading: msg("upload"), claimed: msg("prepare") };

export default function StemsPage({ track, visible = true }: { track: StemTrack | null; visible?: boolean }) {
  const { t } = useTranslation();
  const engine = useStemPlayer();
  const song = useStemSong(track, visible);
  const owner = useCurrentUser().data?.isOwner === true;
  const toast = useToast();
  const client = useQueryClient();
  const { hide } = useSplitDeletes();
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const pending = song.data?.pending;
  const failed = pending?.status === 'failed';
  const busy = !!pending && !failed;
  const waiting = busy && ['queued', 'pending'].includes(pending.status);
  const progress = Math.max(0, Math.min(100, pending?.progress ?? 0));
  const ready = song.data?.ready;
  const rebuilding = ready && busy;
  const engineState = ready && ['loading', 'unsupported', 'error'].includes(engine.state) ? engine.state : null;
  // Original can enter a ready mix with its first channel gesture.
  const enabled = !!ready && !engineState;
  const word = engineState === 'loading' ? t("Loading…") : engineState === 'unsupported' ? t("Not available on this computer") : engineState === 'error' ? t("Couldn't load") : rebuilding ? t("Redoing") : failed ? t("Could not split into stems") : waiting ? t("To do") : busy ? t("Splitting") : ready ? t("Split into stems") : song.isPending ? t("Loading…") : song.isError ? t("Couldn't load") : t("Not split");
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(song.data?.createdAt || song.split?.createdAt || '')) / 86400000));
  const estimate = track?.duration ? t('≈ {{seconds}} s', { seconds: Math.round(track.duration * 13 / 180) }) : '';
  const fact = engineState || song.isPending || song.isError ? '' : rebuilding ? t("the file changed · {{progress}} %", { progress }) : failed ? pending.error : waiting ? (!pending.agent.online ? t("no computer connected") : t("In the queue")) : busy ? `${t(phases[pending.phase] || msg("split"))} · ${progress} %` : ready ? Number.isFinite(days) ? t("{{days}} d ago", { days }) : '' : estimate;
  const hue = engineState === 'error' || failed ? '#D8413A' : waiting ? '#F2C24C' : busy || engineState === 'loading' ? '#8A74D8' : ready ? '#5FA046' : '#A49C8C';
  const request = () => song.request.mutate();
  function remove() {
    setMenu(false);
    const split = song.split;
    if (!split) return;
    let release = () => {};
    toast(t("{{title}} · stems deleted", { title: split.title }), {
      undo: () => release(), onDismiss: () => release(), onExpire: () => { void commit(); },
    });
    release = hide([split]);
    async function commit() {
      try {
        await apiDelete('/api/stems/{album}/{file}', { params: { path: { album: split.album, file: split.file } } });
        stemPlayer.refresh(split, true);
        client.setQueryData<ApiData<'/api/stems', 'get'>>(queryKeys.stems.splits(), data => data ? { splits: data.splits.filter(s => splitKey(s) !== splitKey(split)) } : data);
        await client.invalidateQueries({ queryKey: queryKeys.stems.all });
        void client.invalidateQueries({ queryKey: queryKeys.server.storage() });
      } catch { toast(t("Could not delete the stems. Try again."), { err: true }); }
      finally { release(); }
    }
  }
  const status = <>
    <span className="mx-word" title={engineState === 'unsupported' ? engine.reason === 'too-long' ? t("Songs longer than 8 min play the original") : t("This computer cannot decode Ogg Opus") : undefined}><i className="mx-dot" style={{ '--_c': hue } as CSSProperties} />{word}</span>
    <span className="mono">{fact}</span>
  </>;
  const cancel = busy && owner && <button type="button" className="fx-ico" onClick={() => song.cancel.mutate()} disabled={song.cancel.isPending} aria-label={t("Cancel")} title={t("Cancel")}><X /></button>;
  const progressLine = (wide = false) => <div className={`fx-prog${wide ? ' fx-prog--wide' : ''}`} role="progressbar" aria-label={word} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>;
  const more = ready && !busy && <div className="mx-menu-wrap">
          <button ref={moreRef} className="fx-ico" type="button" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label={t("More: redo or delete stems")} title={t("Redo · Delete stems")}><MoreHorizontal /></button>
          <Popover open={menu} onClose={() => setMenu(false)} anchorRef={moreRef} role="menu" className="mx-menu">
            <button role="menuitem" type="button" onClick={() => { setMenu(false); request(); }}>{t("Redo")}</button>
            {owner && <button role="menuitem" type="button" onClick={remove}>{t("Delete stems")}</button>}
          </Popover>
        </div>;
  return <section className="stems-page" aria-label={t('Stems')}>
    {(song.request.isError || song.cancel.isError) && <p className="mx-say" role="alert">{t("Could not complete the action. Try again._repeat")}</p>}
    {enabled ? <div className="fx">
      <div className="fx-head">
        <div className="fx-status" role="status">{status}</div>
        {rebuilding && progressLine()}
        <span className="fx-sp" />
        {!isOriginal(engine.mix) && <button className="fx-reset" type="button" onClick={engine.reset} aria-label={t("Return to original")} title={t("Return to original (all at 0 dB)")}><RotateCcw />{t('Original')}</button>}
        {cancel}
        {more}
      </div>
      <div className="fx-body">
        <div className="fx-rows">
          {STEMS.map(stem => {
            const channel = channels[stem];
            const muted = engine.mix.muted.has(stem), solo = engine.mix.solo.has(stem);
            const name = t(channel.name);
            return <div className={`fx-row${effectiveGain(engine.mix, stem) === 0 ? ' is-silent' : ''}`} key={stem} style={{ '--_h': channel.hue } as CSSProperties}>
              <span className="fx-name"><i />{name}</span>
              <Fader key={`${track?.album}/${track?.file}`} name={name} level={engine.mix.levels[stem]} onLive={level => engine.previewLevel(stem, level)} onCommit={level => engine.setLevel(stem, level)} />
              <div className="fx-ms">
                <button type="button" className={muted ? 'is-m' : ''} aria-label={t("Mute {{name}}", { name })} title={t("Mute")} aria-pressed={muted} onClick={() => engine.toggleMute(stem)}>M</button>
                <button type="button" className={solo ? 'is-s' : ''} aria-label={t('Solo {{name}}', { name })} title={t('Solo')} aria-pressed={solo} onClick={() => engine.toggleSolo(stem)}>S</button>
              </div>
            </div>;
          })}
        </div>
        <FaderScales />
      </div>
    </div> : <div className="fx-wait">
      <div className="fx-wait__line">
        <div className="fx-status" role="status">{status}</div>
        {(engineState === 'error' || song.isError) ? <button type="button" className="mx-btn mx-btn--go" onClick={() => { engine.retry(); void song.refetch(); }}>{t("Retry")}</button> : null}
        {!engineState && !ready && !busy && !song.isPending && !song.isError ? <button type="button" className="mx-btn mx-btn--go" disabled={!track || song.request.isPending} onClick={request}><Layers />{failed ? t("Retry") : t("Split into stems_split")}</button> : null}
        {waiting && <button type="button" className="mx-btn" onClick={() => window.dispatchEvent(new CustomEvent('krobi-show-settings', { detail: { section: 'equipos' } }))}>{t("Helpers")}</button>}
        {cancel}
        {ready && !isOriginal(engine.mix) && <button className="fx-reset" type="button" onClick={engine.reset} aria-label={t("Return to original")} title={t("Return to original (all at 0 dB)")}><RotateCcw />{t('Original')}</button>}
        {more}
      </div>
      {busy && !waiting && progressLine(true)}
      <div className="fx-names" aria-hidden="true">{STEMS.map(stem => <span key={stem} style={{ '--_h': channels[stem].hue } as CSSProperties}><i />{t(channels[stem].name)}</span>)}</div>
    </div>}
  </section>;
}
