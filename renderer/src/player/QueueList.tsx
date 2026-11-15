import React from "react";
import { useSortableList } from "../ui/components/useSortableList";
import { GripVertical, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import CoverTile from "../ui/components/CoverTile";
import { openLibraryAlbum } from "../browse/navigationStore";

/** Use pointer capture because Tauri's native file-drop handler consumes HTML drag events.
 * Commit the reorder on release; keyboard moves announce the new position. */

const LINE = "var(--line)";
const ROW_GAP = 7;

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

export default function QueueList({ queue, scrollerRef, coverOf, labelOf, onPlay, onRemove, onReorder }) {
  const { t } = useTranslation();
  const { rows, active, settling, announce, shiftOf, gripProps } = useSortableList({
    count: queue.length, onReorder, scrollerRef, rowGap: ROW_GAP, liftedClass: "qrow--lifted",
  });

  const untitled = t("Untitled");
  const occurrences = new Map<string, number>();
  return (
    <>
      <div className="qlist" data-dragging={active ? "" : undefined} data-settling={settling ? "" : undefined}>
        {queue.map((track, index) => {
          const identity = track.path || track.title || "track";
          const occurrence = occurrences.get(identity) ?? 0;
          occurrences.set(identity, occurrence + 1);
          const song = track.title || untitled;
          return (
            <div
              key={`${identity}:${occurrence}`}
              ref={(el) => { if (el) rows.current[index] = el; }}
              className="qrow"
              style={{ transform: shiftOf(index), marginBottom: ROW_GAP, border: `2px solid ${LINE}` }}
            >
              <button type="button" className="qrow-cover" onClick={() => onPlay(index)} title={t("Play now")} aria-label={t("Play {{song}}", { song })}>
                <CoverTile src={coverOf(track)} label={labelOf(track)} fontSize="11px" style={{ width: "100%", height: "100%" }} />
                <span className="qrow-cover__play" aria-hidden>
                  <Play size={14} strokeWidth={2.5} fill="currentColor" style={{ marginLeft: 1 }} />
                </span>
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: "var(--dm-ink, #151515)", ...ellipsis }} title={`${song} — ${track.artist || ""}`}>{song}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", ...ellipsis }}>
                  {track.artist || ""}
                  {track.album?.album ? (
                    <>
                      {" · "}
                      <span role="link" tabIndex={-1} className="song-row__album-link" onClick={() => openLibraryAlbum(track)} title={t("Open album")}>
                        {track.album.album}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
              {queue.length > 1 && (
                <button
                  type="button"
                  className="qrow-icon qrow-icon--grip"
                  title={t("Drag to reorder")}
                  aria-label={t("Drag {{song}} to reorder", { song })}
                  {...gripProps(index)}
                >
                  <GripVertical size={18} strokeWidth={2.25} aria-hidden />
                </button>
              )}
              <button type="button" className="qrow-icon" onClick={() => onRemove(index)} title={t("Remove from queue")} aria-label={t("Remove from queue")}>
                <X size={18} strokeWidth={2.25} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <div aria-live="polite" className="sr-only">{announce}</div>
    </>
  );
}
