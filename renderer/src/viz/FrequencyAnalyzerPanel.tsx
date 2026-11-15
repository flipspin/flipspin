import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { msg } from "../i18n";
import { useAudioAnalyzer } from "@state/AudioAnalyzerContext";

// Read the shared analyser and map real-Hz bands using its sample rate.
// Use theme colors with enough contrast for each band's clip, peak or bass-excess mark.
const BANDS = [
  { name: msg("Sub-bass"), lo: 20, hi: 60, color: "var(--coral-deep)" },
  { name: msg("Bass_frequencies"), lo: 60, hi: 250, color: "var(--coral)" },
  { name: msg("Low-mid"), lo: 250, hi: 500, color: "var(--yellow)" },
  { name: msg("Mids"), lo: 500, hi: 2000, color: "var(--green)" },
  { name: msg("High-mid"), lo: 2000, hi: 4000, color: "var(--teal)" },
  { name: msg("Presence"), lo: 4000, hi: 6000, color: "var(--blue)" },
  { name: msg("Brightness"), lo: 6000, hi: 20000, color: "var(--purple)" },
];

const CLIP_LEVEL = 240;   // a bin this loud is effectively maxed out (0–255)
const UPDATE_MS = 80;     // commit React state ~12×/sec (the loop runs per-frame)

function analyzeBands(dataArray: Uint8Array, bufferLength: number, sampleRate: number) {
  const binHz = (sampleRate / 2) / bufferLength;
  return BANDS.map((band) => {
    const start = Math.min(bufferLength - 1, Math.floor(band.lo / binHz));
    const end = Math.min(bufferLength, Math.ceil(band.hi / binHz));
    let sum = 0;
    let peak = 0;
    let clipping = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const amp = dataArray[i];
      sum += amp;
      count++;
      if (amp > peak) peak = amp;
      if (amp >= CLIP_LEVEL) clipping++;
    }
    const average = count > 0 ? Math.round(sum / count) : 0;
    let flag: { key: string; n?: number } | null = null;
    if (clipping > 3) flag = { key: msg("Clip") };
    else if (peak > CLIP_LEVEL) flag = { key: msg("Peak {{n}}"), n: peak };
    else if (band.lo === 60 && average > 180) flag = { key: msg("Excess") };
    return { name: band.name, color: band.color, average, flag };
  });
}

const EMPTY: ReturnType<typeof analyzeBands> = BANDS.map((b) => ({ name: b.name, color: b.color, average: 0, flag: null }));

export default function FrequencyAnalyzerPanel({ active, isPlaying }: { active: boolean; isPlaying: boolean }) {
  const { t } = useTranslation();
  const analyzer = useAudioAnalyzer() as { getAnalyserData: (kind: string) => { dataArray: Uint8Array; bufferLength: number; sampleRate: number } | null } | null;
  const { getAnalyserData } = analyzer!;
  const [bands, setBands] = useState(EMPTY);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    if (!active || !isPlaying) {
      setBands(EMPTY);
      return;
    }
    let frame: number;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - lastUpdateRef.current < UPDATE_MS) return;
      lastUpdateRef.current = now;
      const data = getAnalyserData("frequency");
      if (!data) return;
      setBands(analyzeBands(data.dataArray, data.bufferLength, data.sampleRate));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, isPlaying, getAnalyserData]);

  if (!active) return null;

  return (
    <div className="waveform-meter absolute inset-0 z-[6]">
      {bands.map((b) => (
        <div key={b.name} className="waveform-meter-row">
          <span className="waveform-meter-label">{t(b.name)}</span>
          <div className="waveform-meter-track">
            <div className="waveform-meter-fill" style={{ width: `${(b.average / 255) * 100}%`, background: b.color }} />
          </div>
          {b.flag && <span className="waveform-chip">{t(b.flag.key, { n: b.flag.n })}</span>}
          <span className="waveform-meter-value">{b.average}</span>
        </div>
      ))}
    </div>
  );
}
