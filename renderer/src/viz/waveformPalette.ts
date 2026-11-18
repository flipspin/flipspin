import { readThemeVar } from '@lib/themeColors';

/** The Waveform panel's colours, resolved from the active theme's CSS vars (default = coral). */
export interface WaveformPalette {
  /** The trace and bar colour. */
  outline: string;
  /** The filled envelope / spectrum fill. */
  fill: string;
  /** The idle figure's ink. */
  ink: string;
  /** The idle figure's secondary: axes, graduations. */
  inkMuted: string;
  grid: string;
  midline: string;
}

export const DEFAULT_WAVEFORM_PALETTE: WaveformPalette = {
  outline: '#EF7E55',
  fill: '#F6B79C',
  ink: '#151515',
  inkMuted: '#7C7C73',
  grid: 'rgba(0,0,0,0.12)',
  midline: 'rgba(0,0,0,0.4)',
};

/**
 * Read the palette off `el`; the instance's own container, so a surface can
 * recolour its waveform by setting the vars on an ancestor (the lyrics view
 * tints its drawer to the cover); falling back to the document root.
 */
export function readWaveformPalette(el: Element | null | undefined): WaveformPalette {
  if (typeof document === 'undefined') return DEFAULT_WAVEFORM_PALETTE;
  const cs = getComputedStyle(el || document.documentElement);
  // Dedicated --viz-waveform lets a theme color the waveform independently of
  // the shared --coral accent; falls back to --coral / --coral-fill otherwise.
  return {
    outline: readThemeVar(cs, '--viz-waveform', '--coral', DEFAULT_WAVEFORM_PALETTE.outline),
    fill: readThemeVar(cs, '--viz-waveform-fill', '--coral-fill', DEFAULT_WAVEFORM_PALETTE.fill),
    ink: readThemeVar(cs, '--ink', DEFAULT_WAVEFORM_PALETTE.ink),
    inkMuted: readThemeVar(cs, '--ink-3', DEFAULT_WAVEFORM_PALETTE.inkMuted),
    grid: readThemeVar(cs, '--viz-grid', DEFAULT_WAVEFORM_PALETTE.grid),
    midline: readThemeVar(cs, '--viz-midline', DEFAULT_WAVEFORM_PALETTE.midline),
  };
}
