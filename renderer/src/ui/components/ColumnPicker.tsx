import React, { useContext, useImperativeHandle, useRef, useState } from "react";
import { Popover } from "../react/components/Popover";
import { Check, Columns3, GripVertical, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SONG_COLUMNS,
  EmptySongColumnsContext,
  resetColumns,
  resetColumnWidths,
  setColumnOrder,
  setCoversVisible,
  toggleColumn,
  useSongTableColumns,
} from "../../library/tracks/songTableColumns";
import { useSortableList } from "./useSortableList";

/** Align the trigger with the rows' trailing action column.
 * Portal the popover so the table's clipped overflow cannot cut it off. */
type ColumnPickerProps = {
  className?: string;
  handleRef?: React.Ref<{ open: () => void }>;
  hidden?: boolean;
  kind?: Parameters<typeof setCoversVisible>[0];
};

export default function ColumnPicker({ className = "", handleRef = undefined, hidden = false, kind = "library" }: ColumnPickerProps) {
  const { t } = useTranslation();
  const { hidden: hiddenColumns, covers, order, widths } = useSongTableColumns();
  const emptyColumns = useContext(EmptySongColumnsContext);
  const showCovers = covers[kind];
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(handleRef, () => ({ open: () => setOpen(true) }), []);

  const { rows, active, settling, announce, shiftOf, gripProps } = useSortableList({
    count: order.length,
    enabled: open,
    liftedClass: "song-table-columns__row--lifted",
    onReorder: (from, to) => {
      const next = [...order];
      const [column] = next.splice(from, 1);
      next.splice(to, 0, column);
      setColumnOrder(next);
    },
  });

  const customised = hiddenColumns.length > 0;
  const effectiveHidden = new Set([...hiddenColumns, ...emptyColumns]);
  const visibleCount = SONG_COLUMNS.length - effectiveHidden.size - (showCovers && !effectiveHidden.has("artist") ? 1 : 0) + (showCovers ? 1 : 0);
  const total = SONG_COLUMNS.length + 1;

  return (
    <div className={`song-table-columns ${hidden ? "song-table-columns--context" : ""} ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`song-table-columns__trigger ${customised ? "song-table-columns__trigger--custom" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("Choose columns")}
        title={customised || emptyColumns.length ? t("Columns · {{visible}} of {{total}} shown", { visible: visibleCount, total }) : t("Columns")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <Columns3 size={14} strokeWidth={2.25} aria-hidden />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        aria-label={t("Table columns")}
        className="song-table-columns__menu"
      >
            <div className="song-table-columns__title">
              <span>{t("Columns")}</span>
              <span className="song-table-columns__count" aria-live="polite">
                {visibleCount + 1}/{total + 1}
              </span>
            </div>

            <ul className="song-table-columns__list" data-dragging={active ? "" : undefined} data-settling={settling ? "" : undefined}>
              {/* The title is the row. It stays, and it says so, rather than
                  vanishing from the list and leaving the user to wonder. */}
              <li className="song-table-columns__item song-table-columns__item--locked">
                <span className="song-table-columns__box" aria-hidden>
                  <Check size={11} strokeWidth={3.5} />
                </span>
                <span className="song-table-columns__label">
                  {t("Title")}
                  <small>{t("Always shown")}</small>
                </span>
                <Lock size={12} strokeWidth={2.25} aria-hidden className="song-table-columns__lock" />
              </li>
              <li>
                <label className="song-table-columns__item">
                  <input type="checkbox" className="song-table-columns__input" checked={showCovers} onChange={() => setCoversVisible(kind, !showCovers)} />
                  <span className="song-table-columns__box" aria-hidden>{showCovers && <Check size={11} strokeWidth={3.5} />}</span>
                  <span className="song-table-columns__label">{t("Covers")}</span>
                </label>
              </li>
              {order.map((id, index) => {
                const column = SONG_COLUMNS.find(column => column.id === id)!;
                const folded = column.id === "artist" && showCovers;
                const empty = emptyColumns.includes(column.id);
                const on = !folded && !effectiveHidden.has(column.id);
                const title = empty ? t("No song in this list has {{columna}}", { columna: t(column.label) }) : folded ? t("The artist appears below the title") : undefined;
                return (
                  <li key={column.id} className="song-table-columns__row"
                    ref={el => { if (el) rows.current[index] = el; }}
                    style={{ transform: shiftOf(index) }}
                  >
                    <label className={`song-table-columns__item${empty ? " song-table-columns__item--empty" : ""}`} title={title}>
                      <input
                        type="checkbox"
                        className="song-table-columns__input"
                        checked={on}
                        disabled={folded || empty}
                        title={title}
                        onChange={() => toggleColumn(column.id)}
                      />
                      <span className="song-table-columns__box" aria-hidden>
                        {on && <Check size={11} strokeWidth={3.5} />}
                      </span>
                      <span className="song-table-columns__label">
                        {t(column.label)}
                      </span>
                      {empty && <small className="song-table-columns__empty">{t("empty")}</small>}
                    </label>
                    <button type="button" className="song-table-columns__grip"
                      title={t("Drag {{column}} to reorder", { column: t(column.label) })}
                      aria-label={t("Drag {{column}} to reorder", { column: t(column.label) })}
                      {...gripProps(index)}
                    >
                      <GripVertical size={18} strokeWidth={2.25} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>

            <div aria-live="polite" className="sr-only">{announce}</div>
            <div className="song-table-columns__footer">
              <button
                type="button"
                className="song-table-columns__reset"
                onClick={resetColumns}
                disabled={!customised}
              >
                {t("Show all")}
              </button>
              <button type="button" className="song-table-columns__reset"
                onClick={resetColumnWidths} disabled={Object.keys(widths).length === 0}>
                {t("Reset widths")}
              </button>
            </div>
      </Popover>
    </div>
  );
}
