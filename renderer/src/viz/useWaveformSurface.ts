import type { PlaybackPort } from '../player/engine/PlaybackPort';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { DEFAULT_WAVEFORM_PALETTE, readWaveformPalette, type WaveformPalette } from './waveformPalette';
import type { Surface } from './waveformDraw';

/**
 * The container's palette, re-read whenever the root theme or a tinted
 * ancestor changes. Watches those attributes rather than forcing a
 * computed-style read twice a second for the entire lifetime of the player.
 * A ref, so the draw loop reads the current colours each frame.
 */
export function useWaveformPalette(containerRef: RefObject<HTMLElement | null>): RefObject<WaveformPalette> {
  const paletteRef = useRef<WaveformPalette>(DEFAULT_WAVEFORM_PALETTE);
  useEffect(() => {
    const refresh = () => { paletteRef.current = readWaveformPalette(containerRef.current); };
    refresh();

    const observer = new MutationObserver(refresh);
    let element: HTMLElement | null = containerRef.current;
    while (element) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme'],
      });
      element = element.parentElement;
    }

    return () => observer.disconnect();
  }, [containerRef]);
  return paletteRef;
}

/** The container's CSS size, kept by a ResizeObserver (300×100 until it has laid out). */
export function useElementSize(containerRef: RefObject<HTMLElement | null>): Surface {
  const [dimensions, setDimensions] = useState<Surface>({ width: 0, height: 0 });
  useEffect(() => {
    if (!containerRef.current) return;

    const updateDimensions = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.offsetWidth || containerRef.current.clientWidth || 300;
      const h = containerRef.current.offsetHeight || containerRef.current.clientHeight || 100;
      setDimensions((current) => current.width === w && current.height === h ? current : { width: w, height: h });
    };

    updateDimensions();
    const id = requestAnimationFrame(updateDimensions);

    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(id);
      resizeObserver.disconnect();
    };
  }, [containerRef]);
  return dimensions;
}

/**
 * Observes the engine through the shared analyser and tracks whether it is
 * playing, resuming the analyser's AudioContext on every play.
 */
export function useAudioPlaying(
  audioRef: RefObject<PlaybackPort | null> | undefined,
  connectAudio: (el: PlaybackPort) => void,
  resume: () => void,
): boolean {
  const [isPlaying, setIsPlaying] = useState(false);
  useEffect(() => {
    if (!audioRef?.current) return;
    // Capture the engine so cleanup detaches listeners from the same node
    // (audioRef.current may differ by the time cleanup runs).
    const el = audioRef.current;


    connectAudio(el);

    // Read playback state on mount because the playing event may precede this subscription.
    if (!el.paused && !el.ended) {
      setIsPlaying(true);
      resume();
    }

    const handlePlay = () => {
      connectAudio(el);
      setIsPlaying(true);
      resume();
    };
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    el.addEventListener('play', handlePlay);
    el.addEventListener('pause', handlePause);
    el.addEventListener('ended', handleEnded);

    return () => {
      el.removeEventListener('play', handlePlay);
      el.removeEventListener('pause', handlePause);
      el.removeEventListener('ended', handleEnded);
    };
  }, [audioRef, connectAudio, resume]);
  return isPlaying;
}
