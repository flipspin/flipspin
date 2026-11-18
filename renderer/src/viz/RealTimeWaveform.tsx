import type { PlaybackPort } from '../player/engine/PlaybackPort';
import React, { useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioAnalyzer } from '@state/AudioAnalyzerContext';
import FrequencyAnalyzerPanel from './FrequencyAnalyzerPanel';
import PillDropdown from '../ui/components/PillDropdown';
import { DEFAULT_GENERATOR } from './idleOscilloscope';
import type { AnalyserFrame } from './spectrumDraw';
import {
  IDLE_WAVE_KEY,
  IDLE_WAVE_TYPES,
  loadChoice,
  saveChoice,
  VIEW_MODE_KEY,
  VIEW_MODES,
  type ViewMode,
} from './waveformChoices';
import { useAudioPlaying, useElementSize, useWaveformPalette } from './useWaveformSurface';
import { useWaveformLoop } from './useWaveformLoop';

/** The slice of `useAudioAnalyzer()` the panel reads (the context itself is untyped). */
interface WaveformAnalyzer {
  connectAudio: (el: PlaybackPort) => void;
  getAnalyserData: (type: 'frequency' | 'timeDomain') => AnalyserFrame | null;
  resume: () => void;
  isConnected: boolean;
  hasError: boolean;

}

interface RealTimeWaveformProps {
  audioRef: RefObject<PlaybackPort | null>;
  track: { path?: string | null } | null;
}

export default function RealTimeWaveform({ audioRef, track }: RealTimeWaveformProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadChoice(VIEW_MODE_KEY, VIEW_MODES, 'line'));
  const [idleWaveType, setIdleWaveType] = useState<string>(() => loadChoice(IDLE_WAVE_KEY, IDLE_WAVE_TYPES, DEFAULT_GENERATOR));
  const pickViewMode = (id: ViewMode) => { setViewMode(id); saveChoice(VIEW_MODE_KEY, id); };
  const pickIdleWaveType = (id: string) => { setIdleWaveType(id); saveChoice(IDLE_WAVE_KEY, id); };
  // The mode labels in the current language; the idle formulas are math, not copy.
  const viewModes = useMemo(() => VIEW_MODES.map((m) => ({ ...m, label: t(m.label) })), [t]);

  // "Analysis" toggle: overlay the labelled 7-band frequency meter on top of the
  // waveform. Independent of viewMode so it doesn't disturb the dropdown.
  const [showAnalysis, setShowAnalysis] = useState(false);


  const { connectAudio, getAnalyserData, resume, isConnected, hasError } = useAudioAnalyzer() as WaveformAnalyzer;

  const paletteRef = useWaveformPalette(containerRef);
  const dimensions = useElementSize(containerRef);
  const isPlaying = useAudioPlaying(audioRef, connectAudio, resume);

  const hasActiveSong = Boolean(track);

  // The host visualizer follows the song's playback state.
  const showIdle = !hasActiveSong || !isPlaying;

  useWaveformLoop({
    canvasRef, containerRef, audioRef, paletteRef, dimensions, showIdle, idleWaveType, viewMode,
    isPlaying, isConnected, hasError, getAnalyserData,
  });

  return (
    <div
      ref={containerRef}
      className="w-full h-full min-h-[80px] relative overflow-hidden bg-panel"
    >
      <div className="absolute top-2 left-2 z-10 flex items-center gap-2">
        {/* Mode picker (live) or generating-curve picker (idle): one pill,
            the same component Settings uses. The panel clips overflow, so the
            list can only be as tall as what is left under the button row. */}
        <PillDropdown
          options={showIdle ? IDLE_WAVE_TYPES : viewModes}
          value={showIdle ? idleWaveType : viewMode}
          onChange={showIdle ? pickIdleWaveType : pickViewMode}
          fallbackLabel={showIdle ? 'sin θ' : t("Filled")}
          buttonLabelClassName={showIdle ? 'waveform-formula waveform-formula--clipped' : undefined}
          labelClassName={showIdle ? 'waveform-formula' : undefined}
          menuStyle={{ maxHeight: Math.max(60, dimensions.height - 52) }}
          // The pill shows its own label; PillDropdown is untyped, so every prop reads as required.
          ariaLabel={undefined}
        />
        <button
          type="button"
          onClick={() => setShowAnalysis((v) => !v)}
          aria-pressed={showAnalysis}
          title={t("Frequency analysis")}
          className={`waveform-btn ${showAnalysis ? 'waveform-btn--on' : ''}`}
        >
          {t("Analysis")}
        </button>
      </div>
      <FrequencyAnalyzerPanel active={showAnalysis} isPlaying={isPlaying} />
      {/* The draw effect owns the backing-store size (CSS size × devicePixelRatio). */}
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}
