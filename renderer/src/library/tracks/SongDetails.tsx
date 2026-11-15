import React, { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import i18n, { msg } from "../../i18n";
import { formatDuration } from "@lib/formatting";
import { usePlayHistory } from "@lib/playHistory";
import { Missing } from "../../ui/react/components/Missing";
import { LYRIC_LABELS, lyricStateFor, useLyricStates } from "../../lyrics/lyricStates";
import "./track-info.css";
import { MoodEstimate } from "../../analysis/MoodEstimate";

/** Auxiliary file and device facts stay available in the song window. */

// The mood the backend's `_classify_mood` returns (music/repositories.py), in
// the words and colours "Your library" uses for the same moods.
const MOODS = {
  romantic: { label: msg("Romantic"), color: "var(--coral)" },
  groovy: { label: msg("Groovy"), color: "var(--coral)" },
  upbeat: { label: msg("Upbeat"), color: "var(--purple)" },
  calm: { label: msg("Calm"), color: "var(--teal)" },
  melancholic: { label: msg("Melancholic"), color: "var(--teal)" },
  dark: { label: msg("Dark"), color: "var(--blue)" },
  aggressive: { label: msg("Aggressive"), color: "var(--rose)" },
  ambient: { label: msg("Ambient"), color: "var(--green)" },
};

// Raw librosa means with no fixed ceiling: each bar is scaled against a
// generous "loud/bright/busy track" value. The number is the measurement.
const METERS = [
  { key: "energy", label: msg("Energy"), hint: msg("Average loudness (RMS)"), max: 0.3, color: "var(--coral)" },
  { key: "brightness", label: msg("Brightness"), hint: msg("Spectral centroid"), max: 0.5, color: "var(--yellow)" },
  { key: "pulse", label: msg("Pulse"), hint: msg("Onset strength"), max: 3, color: "var(--teal)" },
];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <>
      <dt title={hint}>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ti-section">
      <h4 className="ti-h">{title}</h4>
      <dl className="ti-dl">{children}</dl>
    </section>
  );
}


export default function SongDetails({ track }: { track: import("./songWindowStore").SongTrack }) {
  const { t } = useTranslation();
  const history = usePlayHistory();
  const lyricStates = useLyricStates();
  const analysis = (track.analysis || {}) as Record<string, number>;
  const plays = history[track.path];
  const lyric = lyricStateFor(track, lyricStates);
  const mood = MOODS[String(track.mood || analysis.mood)];
  const date = (seconds) => new Date(seconds * 1000).toLocaleDateString(i18n.language, { year: "numeric", month: "short", day: "numeric" });
  return <details className="song-details"><summary>{t("More information")}</summary>
    <Section title={t("Song")}>
      {mood ? <Row label={t("Mood_mood")}><MoodEstimate>{t(mood.label)}</MoodEstimate></Row> : null}
      <Row label={t("Duration")}>{isNum(track.duration) ? formatDuration(track.duration) : <Missing kind="unanalysed" />}</Row>
      <Row label={t("Added")}>{track.dateAdded ? date(Number(track.dateAdded)) : <Missing kind="nodata" />}</Row>
      <Row label={t("Lyrics")}>{t(LYRIC_LABELS[lyric])}</Row>
    </Section>
    <Section title={t("Analysis")}>
          {METERS.map((m) => {
            const v = analysis[m.key];
            const pct = isNum(v) ? Math.max(2, Math.min(100, (v / m.max) * 100)) : 0;
            return (
              <Row key={m.key} label={t(m.label)} hint={t(m.hint)}>
                {isNum(v) ? (
                  <span className="ti-meter">
                    <span className="ti-bar" aria-hidden>
                      <i style={{ width: `${pct}%`, background: m.color }} />
                    </span>
                    <span className="ti-num">{v.toFixed(3)}</span>
                  </span>
                ) : (
                  <Missing kind="unanalysed" />
                )}
              </Row>
            );
          })}
    </Section>
        <Section title={t("On this computer_device")}>
          <Row label={t("Plays")}><span className="ti-num">{plays?.n || 0}</span></Row>
          <Row label={t("Last played")}>{plays?.at ? date(plays.at / 1000) /* ms (Date.now()) */ : <Missing kind="never" reason={t("Never played on this device")} />}</Row>
        </Section>
  </details>;
}
