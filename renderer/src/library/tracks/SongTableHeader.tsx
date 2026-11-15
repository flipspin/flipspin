import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import { SortHeader } from "../../ui/components/SortHeader";
import ColumnPicker from "../../ui/components/ColumnPicker";
import { useSongTableGridStyle, songColumnMin, type SongWidthId, type SongTableKind } from "./songTableColumns";

import { useSongColumnResize } from "./useSongColumnResize";

type Props = {
  sortField?: string | null;
  sortDir?: string;
  onSort?: (field: string) => void;
  /** Sticks to the top of a page that scrolls as a whole (Playlists). */
  sticky?: boolean;
  numberTitle?: string;
  columnPicker?: boolean;
  onColumns?: () => void;
  kind?: SongTableKind;
};

/** Render every header cell and hide columns through the shared table classes
 * so headers stay aligned with rows. */
export default function SongTableHeader({ sortField = null, sortDir = "asc", onSort, sticky = false, numberTitle, columnPicker = true, onColumns, kind = "library" }: Props) {
  const { t } = useTranslation();
  const picker = useRef<{ open: () => void }>(null);
  const gridStyle = useSongTableGridStyle();
  const sort = { sortField, sortDir, onSort };
  const header = useSongColumnResize();
  const cell = (id: SongWidthId, label: string, align: "left" | "center" | "right" = "left", sortable = true) => (
    <div className={`song-col--${id} song-column-header`} data-resize-column={id}>
      {sortable ? <SortHeader field={id} label={label} align={align} {...sort} /> : <span data-column-label className={align === "center" ? "block text-center" : undefined}>{label}</span>}
      <span className="song-column-resize" role="separator" tabIndex={0}
        data-column-id={id} data-resize-side="right" aria-orientation="vertical"
        aria-label={t("Resize {{column}}", { column: label })}
        aria-valuemin={songColumnMin(id)} aria-valuemax={600} aria-valuenow={songColumnMin(id)} />
    </div>
  );
  return (
    <div ref={header} style={gridStyle} onContextMenu={e => { e.preventDefault(); if (onColumns) onColumns(); else picker.current?.open(); }} className={`retro-song-table__header ${sticky ? "sticky top-0 z-(--z-sticky) " : ""}song-grid px-3 py-2.5 flex-shrink-0`}>
      <div className="song-col--num text-center" title={numberTitle}>#</div>
      <div className="song-col--cover" aria-hidden />
      {cell("title", t("Title"))}
      {cell("artist", t("Artist"))}
      {cell("album", t("Album"))}
      {cell("genre", t("Genre"))}
      {cell("date", t("Date"), "center")}
      {cell("analysis", t("Info"), "center", false)}
      {cell("key", t("Key_tone"), "center")}
      {cell("bpm", "BPM", "center")}
      {cell("lyrics", t("Lyrics"), "left", false)}
      {cell("duration", t("Duration"), "right")}
      {/* Over the rows' download cell (per-device state; account saving
          happens in Explorar): the control that picks which columns show. */}
      <div className="acquire-row-end">{columnPicker && <ColumnPicker kind={kind} handleRef={picker} className="w-8 shrink-0" />}</div>
    </div>
  );
}
