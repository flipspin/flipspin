import { isTrackPresent, markTrackAbsent, useTrackPresence } from '../library/trackPresence';
import { PlaybackController } from '../player/PlaybackController';
import { playingWithIntent, type PlayerState, type FailureCause } from '../player/playerState';
import { playbackNotice } from '../player/notices';
import { playbackEngine } from '../player/engine/PlaybackEngine';
import type { PlaybackPort } from '../player/engine/PlaybackPort';
import { useTrackPlayback } from '../player/useTrackPlayback';
import { albumKey, orderedAlbum } from '../player/volumeLevelling';
import { useOffline, useLocalCopies } from "../offline/useOffline";
import { relPathForTrack } from "@lib/api";
import { useConnection } from "../connection/connection";
import React, { createContext, useContext, useRef, useState, useEffect, useCallback, useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { AudioProgressProvider } from './AudioProgressContext';
import { usePersistedQueue, useStoredString } from './playerPersistence';
import {
  HISTORY_CAP,
  STORAGE_SHUFFLE,
  loadPersisted,
  shuffleArray,
  shufflePool,
  withoutOne,
  type PlayerTrack,
} from './playerQueue';
import { useMediaSession } from './useMediaSession';
import { createBackgroundPreSplit } from '../stems/background';

export type { PlayerTrack, PlayerAlbum } from './playerQueue';
// eslint-disable-next-line react-refresh/only-export-components
export { useAudioProgress, useAudioDuration } from './AudioProgressContext';

export interface PlayOptions {
  replaceQueue?: boolean;
  /** What comes after `track`, in order. */
  upcomingTracks?: PlayerTrack[];
  /** The whole list the play came from (a playlist, an album); what shuffle draws from. */
  context?: PlayerTrack[];
  /** What was played as a whole, when it has a name to mark (a playlist card). */
  source?: PlaySource;
}

/**
 * The named thing playing, so its card can show as current. Set by a play that
 * replaces the queue and passes one; any other queue-replacing play, and
 * clearing the queue, drop it. Editing the queue (add, reorder) keeps it.
 * Not persisted: after a reload the songs come back, the mark does not.
 */
export type PlaySource = { kind: "playlist"; name: string };

type TrackHandler = (() => void) | null;

export interface AudioPlayerValue {
  /** Compatibility name for the stable engine port; never a media element. */
  audioRef: React.RefObject<PlaybackPort | null>;
  isPlaying: boolean;
  playerState: PlayerState;
  failureCause: FailureCause | null;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  selectedTrack: PlayerTrack | null;
  waitingForNest: boolean;
  albumOrder: boolean;
  nowPlaying: PlayerTrack | null;
  /** See PlaySource. */
  source: PlaySource | null;
  setSelectedTrack: (track: PlayerTrack | null, opts?: { replace?: boolean; playNow?: boolean }) => void;
  visualizationType: string;
  setVisualizationType: Dispatch<SetStateAction<string>>;
  svgWaveformStyle: string;
  setSvgWaveformStyle: Dispatch<SetStateAction<string>>;
  audioWaveformStyle: string;
  setAudioWaveformStyle: Dispatch<SetStateAction<string>>;
  shuffleEnabled: boolean;
  setShuffleEnabled: Dispatch<SetStateAction<boolean>>;
  toggleShuffle: () => void;
  nextTrackHandler: TrackHandler;
  setNextTrackHandler: Dispatch<SetStateAction<TrackHandler>>;
  prevTrackHandler: TrackHandler;
  setPrevTrackHandler: Dispatch<SetStateAction<TrackHandler>>;
  queue: PlayerTrack[];
  history: PlayerTrack[];
  play: (track: PlayerTrack | null, options?: PlayOptions) => void;
  playNext: (track: PlayerTrack | null) => void;
  addNextInQueue: (tracks: PlayerTrack | PlayerTrack[]) => void;
  addToQueue: (tracks: PlayerTrack | PlayerTrack[]) => void;
  removeFromQueue: (index: number) => void;
  reorderQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  removeDeletedSongs: () => void;
  clearAll: () => void;
  setQueueWithTracks: (tracks?: PlayerTrack[], startIndex?: number, source?: PlaySource) => void;
  goNext: () => void;
  goPrevious: () => void;
  playQueueItemAt: (index: number) => void;
}

const AudioPlayerContext = createContext<AudioPlayerValue | undefined>(undefined);

export function AudioPlayerProvider({ children }: { children?: React.ReactNode }) {
  const audioRef = useRef<PlaybackPort>(playbackEngine);
  const advanceRef = useRef(() => {});
  const [controller] = useState(() => new PlaybackController({
    advance: () => advanceRef.current(), notice: playbackNotice,
    missing: track => markTrackAbsent({ relPath: track.key }),
  }));
  const present = useTrackPresence();
  const playback = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const isPlaying = playingWithIntent(playback.state, playback.intent);
  const connection = useConnection();
  const restoredTrack = useRef<PlayerTrack | null>(null);
  const [restoredPending, setRestoredPending] = useState(false);

  const [nowPlaying, setNowPlaying] = useState<PlayerTrack | null>(null);
  const nowPlayingRef = useRef(nowPlaying);
  nowPlayingRef.current = nowPlaying;
  const setNowPlayingState = useCallback((track: PlayerTrack | null, restart = false) => {
    if (restart || track?.path !== nowPlayingRef.current?.path) controller.prepareSelection();
    nowPlayingRef.current = track;
    setNowPlaying(restart && track ? { ...track } : track);
  }, [controller]);
  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [history, setHistory] = useState<PlayerTrack[]>([]);
  const [orderedAlbumKey, setOrderedAlbumKey] = useState<string | null>(null);
  const [source, setSource] = useState<PlaySource | null>(null);
  const backgroundPreSplit = useMemo(() => createBackgroundPreSplit(), []);
  useEffect(() => {
    backgroundPreSplit.schedule(nowPlaying && present(nowPlaying) ? nowPlaying : null, queue.filter(present), isPlaying);
    return () => backgroundPreSplit.cancel();
  }, [backgroundPreSplit, nowPlaying, queue, isPlaying, present]);
  // Natural (pre-shuffle) order of the upcoming queue. `queue` is the live
  // playback order; shuffled or not; while this ref preserves the order the
  // tracks were added in, so toggling shuffle can reshuffle or restore in place.
  const baseQueueRef = useRef<PlayerTrack[]>([]);
  // Keep the full playback context so shuffle can include songs before the selected track.
  const contextRef = useRef<PlayerTrack[]>([]);

  const [visualizationType, setVisualizationType] = useStoredString('preferredVisType', 'svg');
  const [svgWaveformStyle, setSvgWaveformStyle] = useStoredString('preferredSvgStyle', 'area');
  const [audioWaveformStyle, setAudioWaveformStyle] = useStoredString('preferredAudioStyle', 'sine');
  const [shuffleEnabled, setShuffleEnabled] = useState(() => localStorage.getItem(STORAGE_SHUFFLE) === 'true');
  // Mirror of shuffleEnabled read by toggleShuffle so two quick clicks (the
  // player-bar button and the Cola button both call it) can't both capture the
  // same stale render value and land on the wrong state.
  const shuffleEnabledRef = useRef(shuffleEnabled);
  shuffleEnabledRef.current = shuffleEnabled;
  const [nextTrackHandler, setNextTrackHandler] = useState<TrackHandler>(null);
  const [prevTrackHandler, setPrevTrackHandler] = useState<TrackHandler>(null);

  const selectedTrack = nowPlaying;
  const offline = useOffline();
  const localKey = selectedTrack?.relPath || relPathForTrack(selectedTrack, null);
  const copies = useLocalCopies(localKey ? [localKey] : []);
  const waitingForNest = restoredPending && selectedTrack === restoredTrack.current;
  const waitingRef = useRef(waitingForNest);
  waitingRef.current = waitingForNest;
  const setIsPlaying = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
    const current = controller.getSnapshot();
    const next = typeof value === 'function' ? value(playingWithIntent(current.state, current.intent)) : value;
    if (next && nowPlayingRef.current && !isTrackPresent(nowPlayingRef.current)) {
      playbackNotice('deleted', '');
      controller.setIntent(false);
      return;
    }
    controller.setIntent(waitingRef.current && next ? false : next);
  }, [controller]);

  useEffect(() => {
    const { nowPlaying: np, queue: q, base } = loadPersisted();
    if (np) {
      restoredTrack.current = np;
      setRestoredPending(true);
      setNowPlayingState(np);
    }
    if (Array.isArray(q) && q.length) {
      // The live queue may be shuffled; the baseline is the natural order, so
      // restore them independently rather than seeding base from the queue.
      baseQueueRef.current = Array.isArray(base) && base.length ? base : q;
      setQueue(q);
    }
  }, [setNowPlayingState]);

  useEffect(() => {
    if (connection.state === "connected" || (offline && localKey && copies.has(localKey))) setRestoredPending(false);
  }, [connection.state, offline, localKey, copies]);

  useEffect(() => {
    localStorage.setItem(STORAGE_SHUFFLE, String(shuffleEnabled));
  }, [shuffleEnabled]);

  // Run after restore so persistence cannot erase the saved queue.
  usePersistedQueue(nowPlaying, queue, baseQueueRef);

  const addToHistory = useCallback((track: PlayerTrack | null) => {
    if (!track) return;
    setHistory((prev) => [track, ...prev].slice(0, HISTORY_CAP));
  }, []);

  // Drop ONE occurrence of a track from the natural-order baseline (used when it
  // leaves the queue); see `withoutOne`.
  const dropFromBase = useCallback((path: string | null | undefined) => {
    baseQueueRef.current = withoutOne(baseQueueRef.current, path);
  }, []);

  // Flip shuffle and immediately re-derive the live queue from the natural
  // baseline; shuffling in place when enabling, restoring order when disabling.
  const toggleShuffle = useCallback(() => {
    const next = !shuffleEnabledRef.current;
    shuffleEnabledRef.current = next;
    setShuffleEnabled(next);
    const base = baseQueueRef.current;
    setQueue(next ? shuffleArray(shufflePool(contextRef.current, base, nowPlayingRef.current).filter(isTrackPresent)) : [...base]);
  }, []);

  // Automatic failure skips retain the budget; public transport actions reset it.
  const advance = useCallback(() => {
    if (controller.isStopped) return;
    const index = queue.findIndex(isTrackPresent);
    if (index < 0) {
      if (queue.length || (nowPlaying && !isTrackPresent(nowPlaying))) controller.stopEmptyQueue();
      else controller.setIntent(false, 'automatic');
      return;
    }
    if (nowPlaying && isTrackPresent(nowPlaying)) addToHistory(nowPlaying);
    for (const track of queue.slice(0, index + 1)) dropFromBase(track.path);
    const next = queue[index];
    setNowPlayingState(next, true);
    setQueue((prev) => prev.slice(index + 1));
    controller.setIntent(true, 'automatic');
  }, [queue, nowPlaying, addToHistory, dropFromBase, controller, setNowPlayingState]);

  const goNext = useCallback(() => {
    controller.userAction();
    advance();
  }, [controller, advance]);

  const goPrevious = useCallback(() => {
    controller.userAction();
    const el = audioRef?.current;
    // The engine's own clock, not the ~4 Hz `progress` state: this callback
    // must not depend on the playhead, or every consumer of the context would
    // get a new `goPrevious` four times a second.
    if (el && (el.currentTime || 0) > 3) {
      el.currentTime = 0;
      return;
    }
    if (history.length === 0) {
      if (el) el.currentTime = 0;
      return;
    }
    const index = history.findIndex(isTrackPresent);
    if (index < 0) return;
    if (nowPlaying) {
      baseQueueRef.current = [nowPlaying, ...baseQueueRef.current];
      setQueue((prev) => [nowPlaying, ...prev]);
    }
    const prev = history[index];
    setHistory((h) => h.slice(index + 1));
    setNowPlayingState(prev, true);
    setIsPlaying(true);
  }, [controller, history, nowPlaying, setIsPlaying, setNowPlayingState]);

  const play = useCallback((track: PlayerTrack | null, options: PlayOptions = {}) => {
    if (!track) return;
    if (!isTrackPresent(track)) { playbackNotice('deleted', ''); return; }
    controller.userAction();
    const { replaceQueue = false, upcomingTracks = [], context = [], source: from = null } = options;
    let nextQueue = queue;
    if (replaceQueue) {
      setSource(from);
      setOrderedAlbumKey(from?.kind === 'playlist' ? null : orderedAlbum(context));
    } else setOrderedAlbumKey(null);
    if (replaceQueue && Array.isArray(upcomingTracks)) {
      const filtered = upcomingTracks.filter((t) => t && isTrackPresent(t) && t.path !== track.path);
      baseQueueRef.current = filtered;
      contextRef.current = Array.isArray(context) ? context.filter(isTrackPresent) : [];
      nextQueue = shuffleEnabled ? shuffleArray(shufflePool(contextRef.current, filtered, track)) : filtered;
    }
    if (nowPlaying && nowPlaying.path !== track.path) {
      addToHistory(nowPlaying);
    }
    setNowPlayingState(track);
    setQueue(nextQueue);
    setIsPlaying(true);
  }, [controller, queue, nowPlaying, shuffleEnabled, addToHistory, setIsPlaying, setNowPlayingState]);

  const playNext = useCallback((track: PlayerTrack | null) => {
    setOrderedAlbumKey(null);
    if (!track) return;
    baseQueueRef.current = [track, ...baseQueueRef.current];
    setQueue((prev) => [track, ...prev]);
  }, []);

  const addNextInQueue = useCallback((tracks: PlayerTrack | PlayerTrack[]) => {
    setOrderedAlbumKey(null);
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (list.length === 0) return;
    baseQueueRef.current = [...list, ...baseQueueRef.current];
    setQueue((prev) => [...list, ...prev]);
  }, []);

  const addToQueue = useCallback((tracks: PlayerTrack | PlayerTrack[]) => {
    setOrderedAlbumKey(null);
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (list.length === 0) return;
    baseQueueRef.current = [...baseQueueRef.current, ...list];
    setQueue((prev) => [...prev, ...list]);
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    setOrderedAlbumKey(null);
    setQueue((prev) => {
      dropFromBase(prev[index]?.path);
      return prev.filter((_, i) => i !== index);
    });
  }, [dropFromBase]);

  const reorderQueue = useCallback((from: number, to: number) => {
    setOrderedAlbumKey(null);
    if (from === to || from < 0 || to < 0) return;
    setQueue((prev) => {
      if (from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      // A manual drag becomes the new natural baseline, so it survives a shuffle toggle.
      baseQueueRef.current = next;
      contextRef.current = [];
      return next;
    });
  }, []);

  const removeDeletedSongs = useCallback(() => {
    baseQueueRef.current = baseQueueRef.current.filter(isTrackPresent);
    contextRef.current = contextRef.current.filter(isTrackPresent);
    setQueue(prev => prev.filter(isTrackPresent));
  }, []);

  const clearQueue = useCallback(() => {
    setOrderedAlbumKey(null);
    baseQueueRef.current = [];
    contextRef.current = [];
    setSource(null);
    setQueue([]);
  }, []);

  const clearAll = useCallback(() => {
    setOrderedAlbumKey(null);
    baseQueueRef.current = [];
    contextRef.current = [];
    setQueue([]);
    setSource(null);
    setNowPlayingState(null);
    setHistory([]);
    setIsPlaying(false);
  }, [setIsPlaying, setNowPlayingState]);

  const setSelectedTrack = useCallback((track: PlayerTrack | null, opts: { replace?: boolean; playNow?: boolean } = {}) => {
    setOrderedAlbumKey(null);
    const { replace = false, playNow = true } = opts;
    if (!track) return;
    if (!isTrackPresent(track)) { playbackNotice('deleted', ''); return; }
    controller.userAction();
    if (replace || (!nowPlaying && queue.length === 0)) {
      play(track, { replaceQueue: true, upcomingTracks: [] });
      if (playNow) setIsPlaying(true);
      return;
    }
    const inQueue = queue.findIndex((t) => t.path === track.path);
    if (inQueue !== -1) {
      const rest = queue.filter((_, i) => i !== inQueue);
      dropFromBase(track.path);
      if (nowPlaying) addToHistory(nowPlaying);
      setNowPlayingState(track);
      setQueue(rest);
      if (playNow) setIsPlaying(true);
      return;
    }
    if (nowPlaying && nowPlaying.path === track.path) {
      if (playNow) setIsPlaying(true);
      return;
    }
    addToHistory(nowPlaying);
    setNowPlayingState(track);
    if (playNow) setIsPlaying(true);
  }, [controller, nowPlaying, queue, play, addToHistory, dropFromBase, setIsPlaying, setNowPlayingState]);

  const setQueueWithTracks = useCallback((tracks: PlayerTrack[] = [], startIndex = 0, from: PlaySource | null = null) => {
    if (!Array.isArray(tracks) || tracks.length === 0) return;
    const requested = tracks[Math.min(Math.max(startIndex, 0), tracks.length - 1)];
    tracks = tracks.filter(isTrackPresent);
    if (!tracks.length) { controller.userAction(); controller.stopEmptyQueue(); return; }
    startIndex = Math.max(0, tracks.indexOf(requested));
    controller.userAction();
    setSource(from);
    setOrderedAlbumKey(from?.kind === 'playlist' ? null : orderedAlbum(tracks));
    const idx = Math.min(Math.max(startIndex, 0), tracks.length - 1);
    const track = tracks[idx];
    const upcoming = [...tracks.slice(0, idx), ...tracks.slice(idx + 1)];
    baseQueueRef.current = upcoming;
    contextRef.current = [];
    const nextQueue = shuffleEnabled ? shuffleArray(upcoming) : upcoming;
    setNowPlayingState(track);
    setQueue(nextQueue);
    setIsPlaying(true);
  }, [controller, shuffleEnabled, setIsPlaying, setNowPlayingState]);

  const playQueueItemAt = useCallback((index: number) => {
    setOrderedAlbumKey(null);
    if (index < 0 || index >= queue.length) return;
    controller.userAction();
    const track = queue[index];
    if (!isTrackPresent(track)) { playbackNotice('deleted', ''); return; }
    dropFromBase(track?.path);
    if (nowPlaying) addToHistory(nowPlaying);
    setQueue((prev) => prev.filter((_, i) => i !== index));
    setNowPlayingState(track, true);
    setIsPlaying(true);
  }, [controller, queue, nowPlaying, addToHistory, dropFromBase, setIsPlaying, setNowPlayingState]);

  const nextRef = useRef(goNext);
  const prevRef = useRef(goPrevious);
  nextRef.current = goNext;
  prevRef.current = goPrevious;
  useEffect(() => {
    setNextTrackHandler(() => (() => { nextRef.current(); }));
    setPrevTrackHandler(() => (() => { prevRef.current(); }));
    return () => {
      setNextTrackHandler(null);
      setPrevTrackHandler(null);
    };
  }, [setNextTrackHandler, setPrevTrackHandler]);

  advanceRef.current = advance;
  useTrackPlayback({ audioRef, selectedTrack: selectedTrack && present(selectedTrack) ? selectedTrack : null, controller, waitingForNest,
    albumOrder: !shuffleEnabled && orderedAlbumKey !== null && albumKey(nowPlaying) === orderedAlbumKey,
    nextTrack: queue.find(present) || null, connected: connection.state === 'connected' });

  useMediaSession({ nowPlaying: waitingForNest ? null : nowPlaying, isPlaying, setIsPlaying, nextRef, prevRef });

  const value = useMemo<AudioPlayerValue>(
    () => ({
        audioRef,
        isPlaying,
        playerState: playback.state,
        failureCause: playback.cause,
        setIsPlaying,
        selectedTrack,
        waitingForNest,
        albumOrder: !shuffleEnabled && orderedAlbumKey !== null && albumKey(nowPlaying) === orderedAlbumKey,
        nowPlaying,
        source,
        setSelectedTrack,
        visualizationType,
        setVisualizationType,
        svgWaveformStyle,
        setSvgWaveformStyle,
        audioWaveformStyle,
        setAudioWaveformStyle,
        shuffleEnabled,
        setShuffleEnabled,
        toggleShuffle,
        nextTrackHandler,
        setNextTrackHandler,
        prevTrackHandler,
        setPrevTrackHandler,
        queue,
        history,
        play,
        playNext,
        addNextInQueue,
        addToQueue,
        removeFromQueue,
        reorderQueue,
        clearQueue,
        removeDeletedSongs,
        clearAll,
        setQueueWithTracks,
        goNext,
        goPrevious,
        playQueueItemAt,
      }),
    [
      isPlaying,
      playback.state,
      playback.cause,
      setIsPlaying,
      selectedTrack,
      waitingForNest,
      orderedAlbumKey,
      nowPlaying,
      source,
      setSelectedTrack,
      visualizationType,
      svgWaveformStyle,
      audioWaveformStyle,
      // useState setters (through useStoredString): stable, listed for the linter.
      setVisualizationType,
      setSvgWaveformStyle,
      setAudioWaveformStyle,
      shuffleEnabled,
      toggleShuffle,
      nextTrackHandler,
      prevTrackHandler,
      queue,
      history,
      play,
      playNext,
      addNextInQueue,
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      removeDeletedSongs,
      clearAll,
      setQueueWithTracks,
      goNext,
      goPrevious,
      playQueueItemAt,
    ],
  );

  return (
    <AudioPlayerContext.Provider value={value}>
      <AudioProgressProvider audioRef={audioRef}>{children}</AudioProgressProvider>
    </AudioPlayerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAudioPlayer(): AudioPlayerValue {
  const context = useContext(AudioPlayerContext);
  if (context === undefined) {
    throw new Error('useAudioPlayer must be used within an AudioPlayerProvider');
  }
  return context;
}
