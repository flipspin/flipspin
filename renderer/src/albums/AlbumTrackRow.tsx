import type { LibraryAlbum, LibraryTrack } from "./library.types";
import type { LyricState } from "../lyrics/lyricStates";
import type { ApiData } from "../data";
import React from "react";
import { rowText as t } from "../acquisition/rowText";
import { formatDuration, formatDate } from "@lib/formatting";
import { albumDirName, apiUrl, buildAlbumThumbUrl, parseTrackPath } from "@lib/api";
import { useSongTableGridStyle } from "../library/tracks/songTableColumns";
import CoverTile from "../ui/components/CoverTile";
import { relPathOf } from "@state/userLibraryStore";
import { renderRowEnd, useRowState } from "../acquisition/RowState";
import { useOfflineLibrary } from "../offline/OfflineLibrary";
import { AnalysisValue } from "../analysis/AnalysisValue";
import { renderMissing } from "../ui/react/components/Missing";
import i18n from "../i18n";
import { primaryArtist } from "./artistMatch";
import { LYRIC_LABELS } from "../lyrics/lyricStates";
import { genreLabel } from "./genreLabel";
import '../library/missing-files.css';
import { MOOD_WORDS } from "../analysis/moodWords";

// Lucide's fixed Play glyph (ISC). A plain element avoids mounting two
// forwardRef components for the same unchanging 12px icon in every song.
const playIcon = <svg xmlns="http://www.w3.org/2000/svg" width={12} height={12} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={0} strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-play" aria-hidden><polygon points="6 3 20 12 6 21 6 3" /></svg>;

const oddRowStyle = { color: "var(--color-charcoal)" };

type Props = {
  track: LibraryTrack;
  lyricState?: LyricState;
  deleted?: boolean;
  album?: LibraryAlbum;
  showCovers?: boolean;
  index: number;
  number?: string | number;
  leadingCell?: React.ReactNode;
  rowClassName?: string;
  indent?: number;
  language?: string;
  selected?: boolean;
  isActive?: boolean;
  searchQuery?: string;
  highlightMatches?: (text: string, query: string) => React.ReactNode;
  onSelect?: (track: LibraryTrack, event: React.MouseEvent<HTMLLIElement>) => void;
  playOnClick?: boolean;
  onOpenAlbum?: (track: LibraryTrack) => void;
  onOpenArtist?: (name: string) => void;
  onPlay: (track: LibraryTrack, list?: LibraryTrack[], album?: LibraryAlbum) => void;
  playList?: LibraryTrack[];
  playAlbum?: LibraryAlbum;
  onDownload?: (track: LibraryTrack) => unknown;
  downloadedOnDevice?: boolean;
  onOpenAnalysis?: (track: LibraryTrack) => void;
  onContextMenu?: (track: LibraryTrack, event: React.MouseEvent<HTMLLIElement>) => void;
};

function AlbumTrackRow({
  track,
  deleted = false,
  lyricState = "none",
  album,
  showCovers = false,
  index,
  // What the leading cell prints when the row is at rest: the track number in a
  // grouped view, the position in a flat list. Hovering swaps it for ▶.
  number,
  leadingCell = undefined,
  rowClassName = "",
  // Grouped views nest the rows under a group header; `indent` is the nesting
  // depth so the number column steps in under the group's title.
  indent = 0,
  language: _language,
  selected,
  isActive,
  searchQuery,
  highlightMatches,
  // `onSelect(track, event)`: a click selects (⌘ toggles, Shift extends) —
  // see shared/useSongSelection. Double-click plays.
  onSelect,
  playOnClick = false,
  // Makes the album cell a link to the album's page (omitted on that page).
  onOpenAlbum,
  // Makes the artist cell a link to the artist's page: `onOpenArtist(name)`,
  // with the tag's primary artist (no "feat. …").
  onOpenArtist,
  // Pass stable panel callbacks so memoized rows can skip unrelated playback updates.
  onPlay,
  playList,
  playAlbum,
  onDownload: _onDownload,
  downloadedOnDevice: _downloadedOnDevice = false,
  onOpenAnalysis,
  onContextMenu,
}: Props) {
  const gridStyle = useSongTableGridStyle();
  const rowKey = relPathOf(track);
  const { offline } = useOfflineLibrary();
  const state = useRowState({ offline, trackKey: rowKey, inNest: true, missing: track.missingFromNest });
  const unavailable = state.unavailable || track.missingFromNest;
  const isOddRow = index % 2 !== 0;
  const rowStyle = isOddRow && !isActive ? oddRowStyle : undefined;
  const artistStr = track.artist || album?.artist || "";
  const albumStr = album?.album ?? track.album ?? "";
  const genreText = track.genre ? genreLabel(track.genre, i18n.resolvedLanguage || i18n.language) : "";
  const hasAnalysis = Boolean(track.analysis || track.mood || track.bpm);
  const printedNumber = number ?? index + 1;
  const coverSrc = showCovers ? buildAlbumThumbUrl(
    album?.mediaKey || (album?.path ? albumDirName(album) : parseTrackPath(track.path).albumName),
    album?.coverVersion,
    96,
  ) : null;

  return (
    <li
      data-path={track.path}
      onClick={(e) => {
        if (playOnClick) {
          if (!unavailable && !(state.gone && !state.downloaded)) onPlay(track, playList, playAlbum);
        } else onSelect?.(track, e);
      }}
      onDoubleClick={playOnClick || unavailable || (state.gone && !state.downloaded) ? undefined : () => onPlay(track, playList, playAlbum)}
      aria-disabled={unavailable || undefined}
      title={deleted ? t("Not in your library anymore") : track.missingFromNest ? `File not found${track.missingSince ? ` since ${track.missingSince}` : ''} · ${rowKey}` : unavailable ? t("Unavailable offline") : undefined}
      onContextMenu={(e) => onContextMenu?.(track, e)}
      // `song-grid`: the header and every row place their cells on the same
      // named grid columns (retro-song-table.css), so a column can never sit off
      // its heading and a hidden one collapses in both at once.
      aria-current={isActive ? "true" : undefined}
      aria-selected={onSelect ? Boolean(selected) : undefined}
      // Playing and selected are two different facts, so two looks: yellow is
      // "this is playing", the tint and side bar is "this is selected".
      className={`retro-song-table__row song-grid px-3 py-1.5 cursor-default
        ${rowClassName} ${track.missingFromNest || deleted ? "is-missing" : ""} ${unavailable ? "is-offline-unavailable" : ""} ${state.gone ? "acquire-row--gone" : ""}
        ${isActive ? "retro-song-table__row--active" : ""}
        ${selected ? "retro-song-table__row--selected" : ""}
      `}
      style={indent ? { ...gridStyle, "--song-row-indent": `${indent * 1.25}rem` } as React.CSSProperties : gridStyle}
    >
      {/* Number at rest, ▶ on hover. One cell, two
          layers, so the column never shifts when the button appears. */}
      <div className="song-row__num relative text-center tabular-nums">
        {leadingCell ?? <>
        <span className="song-row__num-label" style={rowStyle}>
          {String(printedNumber).padStart(2, "0")}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPlay(track, playList, playAlbum);
          }}
          disabled={unavailable || (state.gone && !state.downloaded)}
          title={unavailable ? t("Unavailable offline") : state.gone && !state.downloaded ? t("No longer on the nest") : t("Play")}
          aria-label={t("Play {{title}}", { title: track.title })}
          className="song-row__action song-row__play"
        >
          {playIcon}
        </button>
        </>}
      </div>
      <div className="song-col--cover">
        {showCovers && <CoverTile key={coverSrc} src={coverSrc} label={(albumStr || artistStr) as string} className="song-row__cover" fontSize="14px" style={{ background: "var(--panel-2)" }} />}
      </div>
      {/* Keep rows at one height so virtual-list measurements remain valid. The tooltip carries the full title. */}
      <div className="song-col--title truncate overflow-hidden" style={rowStyle} title={track.title || undefined}>
        <span className="song-row__title-text">
          {searchQuery && highlightMatches ? highlightMatches(track.title!, searchQuery) : track.title || renderMissing({ kind: "noTitle" }, t)}
          {deleted ? renderMissing({ kind: "deleted" }, t) : track.missingFromNest ? <span className="song-row__missing">missing</span> : null}
        </span>
        {/* The artist's second line, shown only when the table is too narrow
            for an Artist column (retro-song-table.css). */}
        {/* Always rendered (a blank line without an artist) so every row is
            the same height in that step too. */}
        <span className="song-row__sub" aria-hidden={showCovers ? undefined : true}>
          {artistStr ? (searchQuery && highlightMatches ? highlightMatches(artistStr, searchQuery) : artistStr) : "\u00a0"}
        </span>
      </div>
      <div
        className="song-col--artist truncate overflow-hidden"
        style={rowStyle}
      >
        {onOpenArtist && artistStr ? (
          <span
            role="link"
            tabIndex={-1}
            className="song-row__album-link"
            onClick={(e) => {
              e.stopPropagation();
              onOpenArtist(primaryArtist(artistStr));
            }}
            title={t("Go to artist")}
          >
            {searchQuery && highlightMatches ? highlightMatches(artistStr, searchQuery) : artistStr}
          </span>
        ) : searchQuery && highlightMatches ? (
          highlightMatches(artistStr, searchQuery)
        ) : (
          artistStr || renderMissing({ kind: "noArtist" }, t)
        )}
      </div>
      <div
        className="song-col--album truncate overflow-hidden"
        style={rowStyle}
      >
        {onOpenAlbum && albumStr ? (
          <span
            role="link"
            tabIndex={-1}
            className="song-row__album-link"
            onClick={(e) => {
              e.stopPropagation();
              onOpenAlbum(track);
            }}
            title={t("Open album")}
          >
            {searchQuery && highlightMatches ? highlightMatches(String(albumStr), searchQuery) : String(albumStr)}
          </span>
        ) : searchQuery && highlightMatches ? (
          highlightMatches(String(albumStr), searchQuery)
        ) : (
          albumStr ? String(albumStr) : renderMissing({ kind: "noAlbum" }, t)
        )}
      </div>
      <div className="song-col--genre truncate overflow-hidden" style={rowStyle} title={genreText || undefined}>
        {genreText || null}
      </div>
      <div className="song-col--date text-center" style={rowStyle}>
        {track.dateAdded ? formatDate(track.dateAdded) : null}
      </div>
      <div className="song-col--analysis flex justify-center" style={rowStyle}>
        <button
          type="button"
          title={track.mood ? t("Info · {{mood}}", { mood: `≈ ${t(MOOD_WORDS[track.mood] ?? track.mood)} (${t("Rough guess from tempo and energy")})` }) : t("Information")}
          onClick={(e) => {
            e.stopPropagation();
            onOpenAnalysis?.(track);
          }}
          aria-label={t("Info for {{song}}", { song: track.title || "" })}
          className={`song-row__action song-row__info ${hasAnalysis ? "" : "song-row__info--bare"}`}
        >
          i
        </button>
      </div>
      <div className="song-col--key text-center" style={rowStyle}>
        <AnalysisValue track={track} field="key" sheet onOpenInfo={onOpenAnalysis ? () => onOpenAnalysis(track) : undefined} />
      </div>
      <div className="song-col--bpm text-center" style={rowStyle}>
        <AnalysisValue track={track} field="bpm" onOpenInfo={onOpenAnalysis ? () => onOpenAnalysis(track) : undefined} />
      </div>
      <div className="song-col--lyrics flex items-center gap-1.5" data-state={lyricState}>
        <span className="lyric-state-dot" aria-hidden />{t(LYRIC_LABELS[lyricState])}
      </div>
      <div className="song-col--duration text-right tabular-nums" style={rowStyle}>
        {track.duration ? formatDuration(track.duration) : renderMissing({ kind: "unmeasured", className: "text-[10px] whitespace-nowrap" }, t)}
      </div>
      {renderRowEnd({ library: true, unavailable, trackKey: rowKey, inNest: true, missing: track.missingFromNest, title: track.title, track: { title: track.title!, artistName: artistStr, albumTitle: albumStr as string, durationSeconds: track.duration!, trackPosition: track.track_number! } }, state)}
    </li>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function openTrackFile(path: string) {
  fetch(apiUrl("/api/open-file"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(path),
  })
    .then((res): Promise<ApiData<"/api/open-file", "post">> => res.json())
    .then((data) => {
      // /api/open-file has no response model; inspect only its success flag.
      if (!(typeof data === "object" && data !== null && "success" in data && data.success)) alert(t("The file couldn't be opened."));
    });
}

// Stable handler props let unchanged rows skip playback and queue updates.
export default React.memo(AlbumTrackRow);
