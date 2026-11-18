import { AnalysisValue } from "../analysis/AnalysisValue";
import React, { type ReactNode } from "react";
import type { TFunction } from "i18next";
import { Music2 } from "lucide-react";
import { formatTime } from "@lib/formatting";
import CoverTile from "../ui/components/CoverTile";
import type { LyricsDoc } from "./lyricsStore";
import { albumOf, type LyricsTrack } from "./overlayModel";
import { MoodEstimate } from "../analysis/MoodEstimate";
import { MOOD_WORDS } from "../analysis/moodWords";

/** The right rail: the cover, the song, its tempo/key chips and where the lyric came from. */
export default function LyricsAside({ onOpenInfo, t, track, cover, title, artist, total, doc, source }: {
  onOpenInfo?: (track: LyricsTrack) => void;
  t: TFunction;
  track: LyricsTrack | null;
  cover: string | null;
  title: string;
  artist: string;
  total: number;
  doc: LyricsDoc | null;
  source: string;
}) {
  return (
    <aside className="lyrics-aside">
      <div className="lyrics-cover">
        <CoverTile src={cover} label={title} fontSize="22px" style={{ width: "100%", height: "100%" }} />
      </div>
      <div className="lyrics-aside-title" title={title}>{title}</div>
      {artist && <div className="lyrics-aside-artist">{artist}</div>}
      {track && (
        <div className="lyrics-chips">
          <span><AnalysisValue track={track} field="bpm" unit onOpenInfo={onOpenInfo ? () => onOpenInfo(track) : undefined} /></span><i />
          <span><AnalysisValue track={track} field="key" onOpenInfo={onOpenInfo ? () => onOpenInfo(track) : undefined} /></span>
        </div>
      )}
      <dl className="lyrics-meta">
        <MetaRow k={t("Album")} v={albumOf(track)} />
        <MetaRow k={t("Duration")} v={total > 0 ? formatTime(total) : ""} />
        <MetaRow k={t("Genre")} v={track?.genre} />
        <MetaRow k={t("Mood_mood")} v={track?.mood ? <MoodEstimate>{t(MOOD_WORDS[track.mood] ?? track.mood)}</MoodEstimate> : null} />
        <MetaRow k={t("Lyrics")} v={doc ? source : t("No lyrics")} />
        {doc?.edited && <MetaRow k={t("Correction")} v={<><Music2 size={12} aria-hidden /> {t("Edited by hand")}</>} />}
      </dl>
    </aside>
  );
}

function MetaRow({ k, v }: { k: ReactNode; v: ReactNode }) {
  if (!v) return null;
  return (
    <div className="lyrics-meta-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
