import { useBulkTagMenu } from "../../library/tracks/useBulkTagMenu";
import { reportError } from '../../lib/log';
import RemovalButtons from '../../acquisition/RemovalButtons';
import { useRemoveActions } from '../../acquisition/removeActions';
import { useOffline } from "../../offline/useOffline";
import React, { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useSelectionBarDock } from "./selectionBarDock";
import { useTranslation } from "react-i18next";
import { ArrowDown, ChevronUp, ListEnd, ListPlus, ListStart, Mic2, Play, Tag, X } from "lucide-react";
import { useLyricsMenu } from "../../lyrics/useLyricsMenu";
import TrackContextMenu, { type MenuItem } from "../../albums/TrackContextMenu";
import { isRealUser, useIdentity } from "@state/identityStore";
import { relPathOf } from "@state/userLibraryStore";
import { hasBridge } from "../../bridge";
import { isDownloaded, refreshOffline, useOffline as useOfflineFiles } from "../../acquisition/offline";
import { pinTracks } from "../../acquisition/libraryActions";
import "./selection-bar.css";

/**
 * What a selection can do, docked at the bottom of the main content.
 * Shown for one or more songs. Its menus are the
 * right-click menu's own (same component, same items, same words), so a
 * selection and a single song speak one vocabulary.
 */
type Props = {
  count: number;
  tracks: { path?: string | null; relPath?: string | null }[];
  onPlay: () => void;
  onPlayNext: () => void;
  onQueue: () => void;
  /** "Add to a playlist"; the shared playlist submenu. */
  playlistItems: MenuItem[];
  onClear: () => void;
  /** For a table whose scroller is a sibling of the selection bar. */
  scrollRef?: RefObject<HTMLDivElement | null>;
};

export default function SelectionBar({ count, tracks, onPlay, onPlayNext, onQueue, playlistItems, onClear, scrollRef }: Props) {
  const { t } = useTranslation();
  const offline = useOffline();
  const bulkTagMenu = useBulkTagMenu();
  const editTags = bulkTagMenu(tracks)[0];
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: MenuItem[]; lyrics?: boolean } | null>(null);
  const [error, setError] = useState("");
  const lyricsItems = useLyricsMenu(tracks, onClear, setError);
  const person = useIdentity();
  const keys = [...new Set(tracks.map(track => relPathOf(track)).filter((key): key is string => !!key))];
  const removals = useRemoveActions(tracks, onClear);
  const files = useOfflineFiles(keys);
  const toDownload = keys.filter(key => !isDownloaded(files[key]));
  const [downloading, setDownloading] = useState(false);
  const dock = useSelectionBarDock();
  const sourceRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // One song is acted on from its right-click menu; the bar is for several.
  const visible = count > 1;
  useLayoutEffect(() => {
    if (!visible || !barRef.current) return;
    let scroller: HTMLElement | null = scrollRef?.current ?? sourceRef.current?.parentElement ?? null;
    if (!scrollRef?.current) {
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    }
    if (!scroller) return;
    const bar = barRef.current;
    const original = scroller.style.paddingBottom;
    const base = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
    const measure = () => {
      // Include the dock's bottom gap and shadow so the last row clears it.
      scroller.style.paddingBottom = `${base + bar.getBoundingClientRect().height + 32}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => { observer.disconnect(); scroller.style.paddingBottom = original; };
  }, [visible, dock, scrollRef]);
  if (!visible) return null;

  const downloadReason = !isRealUser(person) ? t("Sign in to your account to add and download.")
    : !hasBridge() ? t("Downloading requires the desktop app.")
    : offline ? t("Disconnected from the nest")
    : !toDownload.length ? t("Already downloaded on this computer") : "";
  const download = async () => {
    setDownloading(true);
    try {
      // One song pin each: a selection is not an album or a playlist, and a
      // song pin is what the row's own ↓ makes, so each can be undone alone.
      for (const key of toDownload) await pinTracks("song", key, [key]);
      await refreshOffline();
      onClear();
    } catch (error) {
      reportError('downloads', { userMessage: t("Could not download"), error });
    } finally { setDownloading(false); }
  };

  // Menus open upward from the dock.
  const openMenu = (e: React.MouseEvent, title: string, items: MenuItem[], lyrics = false) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.top - 6, title, items, lyrics });
  };

  const toolbar = (
      <div ref={barRef} className="selection-bar" role="toolbar" aria-label={t("{{n}} songs selected", { count, n: count })}>
        <span className="selection-bar__count">{t("{{n}} selected", { count, n: count })}</span>
        <span className="selection-bar__rule" aria-hidden />
        <button type="button" className="selection-bar__btn" onClick={onPlay}>
          <Play size={14} fill="currentColor" strokeWidth={0} aria-hidden />
          {t("Play")}
        </button>
        <button type="button" className="selection-bar__btn" onClick={onPlayNext} title={t("Play next")}>
          <ListStart size={15} aria-hidden />
          {t("Next")}
        </button>
        <button type="button" className="selection-bar__btn" onClick={onQueue} title={t("Add to the queue")}>
          <ListEnd size={15} aria-hidden />
          {t("Queue")}
        </button>
        <button type="button" className="selection-bar__btn" onClick={(e) => openMenu(e, t("Add to playlist"), playlistItems)}>
          <ListPlus size={15} aria-hidden />
          {t("Playlist")}
          <ChevronUp size={13} aria-hidden />
        </button>
        <button type="button" className="selection-bar__btn" disabled={!!downloadReason || downloading} title={downloadReason || t("Download to this computer")} onClick={() => void download()}>
          <ArrowDown size={14} strokeWidth={2.5} aria-hidden />
          {t("Download_verb")}
        </button>
        <button type="button" className="selection-bar__btn" aria-haspopup="menu" aria-expanded={Boolean(menu?.lyrics)} onClick={(e) => openMenu(e, t("Lyrics_plural"), lyricsItems, true)}>
          <Mic2 size={14} aria-hidden />{t("Lyrics_plural")}<ChevronUp size={13} aria-hidden />
        </button>
        {editTags && "label" in editTags ? <button type="button" className="selection-bar__btn" disabled={editTags.disabled} title={editTags.tooltip} onClick={editTags.onClick}>
          <Tag size={14} aria-hidden />{editTags.label}
        </button> : null}
        {error && <span role="alert">{error}</span>}
        <RemovalButtons items={removals} buttonClassName="selection-bar__btn" dangerClassName="selection-bar__btn--danger" ruleClassName="selection-bar__rule" />
        <span className="selection-bar__rule" aria-hidden />
        <button type="button" className="selection-bar__close" onClick={onClear} aria-label={t("Clear selection")} title={t("Clear selection (Esc)")}>
          <X size={15} strokeWidth={2.5} aria-hidden />
        </button>
      </div>
  );

  return (
    <>
      <span ref={sourceRef} hidden />
      {dock ? createPortal(toolbar, dock) : toolbar}
      <TrackContextMenu
        upward
        open={Boolean(menu)}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        title={menu?.title}
        items={menu?.lyrics ? lyricsItems : menu?.items ?? []}
        onClose={() => setMenu(null)}
      />
    </>
  );
}
