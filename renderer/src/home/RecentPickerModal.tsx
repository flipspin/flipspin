import type { LibraryAlbum, LibraryTrack } from "../albums/library.types";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate } from "@lib/formatting";
import { buildAlbumCoverUrl } from "@lib/api";
import CoverTile from "../ui/components/CoverTile";
import PanelModal from "../ui/components/PanelModal";

// "Just added" → "Choose song": every song in the library, newest first.
// Picking one pins it to the front of the panel.
// `open` false plays the exit animation (the caller keeps this mounted once
// opened); each opening starts with an empty search.
export default function RecentPickerModal({ open = true, albums = [], shownTracks, onPick, onClose }: { open?: boolean; albums?: LibraryAlbum[]; shownTracks: Set<string>; onPick: (album: LibraryAlbum, track: LibraryTrack) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const rows = useMemo(() => {
    const all: { album: LibraryAlbum; track: LibraryTrack }[] = [];
    for (const album of albums) {
      for (const track of album?.tracks || []) {
        if (track?.path) all.push({ album, track });
      }
    }
    return all.sort((x, y) => (Number(y.track.dateAdded) || 0) - (Number(x.track.dateAdded) || 0));
  }, [albums]);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return rows;
    return rows.filter(({ album, track }) =>
      [track.title, track.artist, album?.album].some((v) => String(v || "").toLocaleLowerCase().includes(q)),
    );
  }, [rows, query]);

  return (
    <PanelModal
      open={open}
      title={t("Choose song")}
      onClose={onClose}
      toolbar={
        <input
          type="search"
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search song, artist or album")}
          className="retro-table-field w-full px-2 py-1.5 text-sm"
        />
      }
    >
      {visible.length === 0 ? (
        <div className="text-sm text-[var(--ink-3)] py-8 text-center">{t("No results")}</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-panel z-10">
            <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--ink-3)] border-b-2 border-black/20">
              <th className="py-2 pl-3 w-12" aria-label={t("Cover")} />
              <th className="py-2 px-2 font-bold">{t("Song")}</th>
              <th className="py-2 px-2 font-bold">{t("Album")}</th>
              <th className="py-2 pr-3 pl-2 font-bold text-right whitespace-nowrap">{t("Added")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ album, track }) => {
              const shown = shownTracks.has(track.path);
              const title = (track.title || t("(untitled)")).toString();
              return (
                <tr
                  key={track.path}
                  onClick={shown ? undefined : () => onPick(album, track)}
                  title={shown ? t("Already on the panel") : t("Put {{song}} first", { song: title })}
                  className={`border-b border-black/10 ${shown ? "opacity-50" : "cursor-pointer hover:bg-[var(--yellow)]/40"}`}
                >
                  <td className="py-1.5 pl-3">
                    <CoverTile
                      src={album?.cover || buildAlbumCoverUrl(album)}
                      label={title}
                      fontSize="12px"
                      className="w-9 h-9 rounded-control border-2 border-black"
                    />
                  </td>
                  <td className="py-1.5 px-2 max-w-0 w-1/2">
                    <span className="block truncate font-bold text-black">{title}</span>
                    <span className="block truncate text-[11px] text-[var(--ink-3)]">
                      {shown ? t("On the panel") : track.artist || ""}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 max-w-0 truncate text-[var(--ink-2)]">{album?.album || ""}</td>
                  <td className="py-1.5 pr-3 pl-2 text-right tabular-nums text-[12px] text-[var(--ink-3)] whitespace-nowrap">
                    {formatDate(track.dateAdded)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </PanelModal>
  );
}
