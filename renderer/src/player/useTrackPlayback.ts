import { trackLibraryKey } from '../library/trackPresence';
import type { PlaybackPort } from './engine/PlaybackPort';
import { useReplayGain } from './useReplayGain';
import { setLevellingGain } from '../stems/audioGraph';
import { gainMultiplier, useVolumeLevelling, type ReplayGain } from './volumeLevelling';
import { useEffect, type RefObject } from 'react';
import type { PlayerTrack } from '../state/playerQueue';
import { buildTrackSrc, API_BASE_URL } from '@lib/api';
import { stemPlayer } from '../stems/StemPlayer';
import { PlaybackController } from './PlaybackController';
import { traceGain } from './trace';
import { useLocalCopies } from '../offline/useOffline';
import { stemTrack } from '../stems/stemApi';

/** Restored media waits for the shell; an already buffered song survives a drop. */
export function useTrackPlayback({ audioRef, selectedTrack, controller, waitingForNest, albumOrder = false, nextTrack, connected }: {
  audioRef: RefObject<PlaybackPort | null>;
  selectedTrack: PlayerTrack | null;
  controller: PlaybackController;
  nextTrack: PlayerTrack | null;
  connected: boolean;
  waitingForNest: boolean;
  albumOrder?: boolean;
}) {
  const levelling = useVolumeLevelling();
  const analysis = selectedTrack?.analysis as { replayGain?: ReplayGain } | undefined;
  const keys = stemTrack(selectedTrack);
  const loudness = useReplayGain(keys?.album, keys?.file, analysis?.replayGain, !waitingForNest && levelling !== 'off');
  const gain = gainMultiplier(loudness.gain, levelling, albumOrder);
  useEffect(() => { setLevellingGain(gain); }, [gain]);
  useEffect(() => {
    const el = audioRef.current;
    if (el) return controller.attach(el);
  }, [audioRef, controller]);
  useEffect(() => { controller.setConnected(connected); }, [controller, connected]);
  useEffect(() => { controller.setBlocked(loudness.pending || waitingForNest); }, [controller, loudness.pending, waitingForNest]);
  useEffect(() => {
    if (waitingForNest) return;
    const el = audioRef.current;
    if (el) stemPlayer.setTrack(stemTrack(selectedTrack), true);
    controller.select(selectedTrack ? {
      key: mediaKey(selectedTrack), src: buildTrackSrc(selectedTrack),
      title: selectedTrack.title || '', origin: new URL(API_BASE_URL).origin,
    } : null);
  }, [selectedTrack, audioRef, controller, waitingForNest]);
  useEffect(() => {
    if (import.meta.env.KROBI_PLAYBACK_TRACE === '1' && !waitingForNest) {
      const album = levelling === 'album' && albumOrder && Number.isFinite(loudness.gain?.albumGain);
      const db = (album ? loudness.gain?.albumGain : loudness.gain?.trackGain) ?? 0;
      traceGain({
        mode: levelling, chosen: loudness.gain ? album ? 'album' : 'track' : 'fallback',
        dB: db, linear: gain, clipped: levelling !== 'off' && gain < 10 ** (db / 20),
      });
    }
  }, [gain, loudness.gain, levelling, albumOrder, selectedTrack, waitingForNest]);
  const nextKey = nextTrack ? mediaKey(nextTrack) : '';
  const copies = useLocalCopies(nextKey ? [nextKey] : []);
  useEffect(() => {
    controller.setNext(nextTrack ? { key: nextKey, src: buildTrackSrc(nextTrack), cached: copies.has(nextKey) } : null);
  }, [controller, nextTrack, nextKey, copies]);
}

function mediaKey(track: PlayerTrack): string {
  return trackLibraryKey(track) ?? track.path;
}
