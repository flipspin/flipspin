import { pluginPages } from "../../plugins";
import { bridge, hasBridge } from "../../bridge";
import { PAGES, SIDEBAR_PAGES } from "../pageTable";
import type { SchemaPlaylistCreateRequest } from "../../api/generated/schema";
import type { ApiData } from "../../data/http";
import type { LucideIcon } from "lucide-react";
import React, { useState, useEffect, useCallback } from "react";
import { apiUrl, buildAlbumThumbUrl } from "@lib/api";
import { ChevronDown, ChevronRight, Clock, Compass, House, Library, Music2, PanelLeft, Pause, Play, Plus, Puzzle, Settings } from "lucide-react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { useStatus } from "../../state/useStatus";
import { fetchPlaylistQueue } from "../../playlists/playlistQueue";
import { CoverMosaic } from "../../ui/components/CoverTile";
import { useOffline, useSnapshotReads } from "../../offline/useOffline";
import { useConnection } from "../../connection/connection";
import { ContentPlaceholder } from "../../ui/components/ContentPlaceholder";
import { fetchPlaylistSummaries } from "@lib/playlistSummaries";
import IsingScreen from "../../viz/IsingScreen";
import krobiMark from "../../assets/krobi-mark.png";
import { playlistCount, playlistCover, playlistCoverAlbums } from "../../playlists/playlistBadge";
import { APP_NAME } from "../../brand";
import { useTranslation } from "react-i18next";
import WindowControls, { hasCustomWindowControls } from "./WindowControls";
import "./sidebar.css";


// Nav row (sidebar canvas, option A2): a tab-shaped strip in the page's
// colour, its icon and label in ink; the page on screen shows its icon and
// label in that colour, bold. The colours are the palette's, softened toward
// ink so they read on the cream sidebar without shouting. Inline
// border/background win over `.sidebar-layout button` (index.css).
type PlaylistSummary = ApiData<"/api/playlists", "get">[number];

const soft = (color: string | undefined) => `color-mix(in oklab, ${color} 75%, var(--ink-2))`;
const NAV_ICONS: Record<string, LucideIcon> = { home: House, dashboard: Compass, albums: Library, settings: Settings };

function NavItem({ color, icon: Icon = Puzzle, label, active, onClick, disabled, title, folded = false }: { color?: string; icon?: LucideIcon; label: string; active: boolean; onClick: () => void; disabled?: boolean; title?: string; folded?: boolean }) {
  const tone = soft(color);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? (folded ? label : undefined)}
      aria-current={active ? "page" : undefined}
      style={{ border: 0, background: "transparent", boxShadow: "none", minHeight: 0, padding: 0, gap: 10, fontFamily: "var(--font-main)", color: active ? tone : "var(--ink)" }}
      className={`flex items-center h-[34px] w-full rounded-[5px] text-left text-[14px] transition-colors duration-(--dur-fast)
        disabled:opacity-45 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-inset
        ${active ? "font-extrabold" : "font-semibold"}`}
    >
      <span aria-hidden className="w-[7px] h-[28px] flex-none rounded-l-[4px]" style={{ background: tone }} />
      <Icon className="w-[17px] h-[17px] flex-none" strokeWidth={active ? 2.25 : 2} aria-hidden />
      <span className="sb-fade truncate">{label}</span>
    </button>
  );
}

// "23m 34s", "5h 7m 32s": the length a playlist row shows.
function spanOf(seconds: number) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
}

function PlaylistItem({ name, covers, count, duration, onClick, isSelected, folded = false, play }: { name: string; covers: string[]; count?: number | null; duration?: number | null; onClick: () => void; isSelected: boolean; folded?: boolean; play?: { current: boolean; playing: boolean; onPlay: () => void; onToggle: () => void } }) {
  const { t } = useTranslation();
  const playing = play?.current && play.playing;
  return (
    <div className="sb-playlist-row relative shrink-0" data-current={play?.current ? "" : undefined}>
    <button
      type="button"
      onClick={onClick}
      title={folded ? name : undefined}
      style={{ padding: 3, border: 0, minHeight: 0, margin: 0, justifyContent: "flex-start" }}
      className={`playlist-item-btn flex shrink-0 items-center gap-2.5 rounded-control w-full min-w-0 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-inset ${isSelected ? "playlist-item-selected" : "hover:bg-gray-100"}`}
    >
      <CoverMosaic covers={covers} label={name} fontSize="13px" className="w-12 h-12 flex-none rounded-control border border-black/15" />
      <span className="sb-fade flex-1 min-w-0 flex flex-col">
        <span className="truncate text-[14px] leading-[19px] font-semibold text-black">{name}</span>
        {(count != null || duration != null) && (
          <span className="flex items-center gap-2.5 whitespace-nowrap text-[12px] leading-[17px] text-[var(--ink-4)]">
            {count != null && (
              <span className="inline-flex items-center gap-1" title={t("{{n}} songs", { count, n: count })}>
                <Music2 className="w-3.5 h-3.5" aria-hidden />{count}
              </span>
            )}
            {duration != null && (
              <span className="inline-flex items-center gap-1" title={t("Duration")}>
                <Clock className="w-3.5 h-3.5" aria-hidden />{spanOf(duration)}
              </span>
            )}
          </span>
        )}
      </span>
    </button>
    {play && (
      <button
        type="button"
        className="sb-cover-play"
        onClick={play.current ? play.onToggle : play.onPlay}
        aria-label={playing ? t("Pause") : t("Play {{name}}", { name })}
        title={playing ? t("Pause") : t("Play")}
      >
        {playing ? <Pause className="w-4 h-4" fill="currentColor" aria-hidden /> : <Play className="w-4 h-4 translate-x-px" fill="currentColor" aria-hidden />}
      </button>
    )}
    </div>
  );
}

// Playlist artwork (a Spotify import's) wins; otherwise a 2×2 of its first
// albums' covers, by directory; the media route's key; as the Playlists grid.
function playlistCovers(p: PlaylistSummary) {
  const own = playlistCover(p);
  return own ? [own] : playlistCoverAlbums(p).map((dir, i) => buildAlbumThumbUrl(dir, p?.coverVersions?.[i], 96)).filter(Boolean);
}

function playlistDuration(p: PlaylistSummary) {
  const d = p && typeof p === "object" ? p.totalDuration : null;
  return typeof d === "number" && d > 0 ? d : null;
}

const COLLAPSED_KEY = "krobi.sidebarPlaylistsCollapsed";
const FOLDED_KEY = "krobi.sidebarFolded";
const BARE_ICON = "grid place-items-center w-6 h-6 rounded-control text-[var(--ink-3)] hover:text-[var(--ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-black";
// `.sidebar-layout button` (index.css, unlayered) frames every sidebar button;
// these two are bare icons.
const BARE_STYLE = { border: 0, background: "transparent", boxShadow: "none", padding: 0, minHeight: 0 };

export default function Sidebar({ activePage, setActivePage, selectedPlaylistName, setSelectedPlaylistName }: { activePage: string; setActivePage: (page: string) => void; selectedPlaylistName?: string | null; setSelectedPlaylistName?: (name: string | null) => void }) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const { play, source, isPlaying, setIsPlaying } = useAudioPlayer();
  const { showError } = useStatus();
  const playPlaylist = async (name: string) => {
    const tracks = await fetchPlaylistQueue(name, showError);
    if (tracks.length === 0) return;
    const [first, ...rest] = tracks;
    play(first, { replaceQueue: true, upcomingTracks: rest, context: tracks, source: { kind: "playlist", name } });
  };
  const [loaded, setLoaded] = useState(false);
  const connection = useConnection();
  const offline = useOffline();
  const snapshotReads = useSnapshotReads();
  const connected = connection.state === "connected" || snapshotReads;
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const toggleList = () => setListCollapsed((v) => {
    try { localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1"); } catch { /* this session only */ }
    return !v;
  });
  // Folded to a strip of icons and covers (sidebar canvas, collapse board):
  // the button beside "Flipspin" folds it, the tab on its edge or ⌘\ unfolds it.
  // Remembered on this computer; it always starts open the first time.
  const [folded, setFolded] = useState(() => {
    try { return localStorage.getItem(FOLDED_KEY) === "1"; } catch { return false; }
  });
  const toggleFolded = useCallback(() => setFolded((v) => {
    try { localStorage.setItem(FOLDED_KEY, v ? "0" : "1"); } catch { /* this session only */ }
    return !v;
  }), []);
  useEffect(() => {
    if (hasBridge()) return bridge().on("view:command", (command) => {
      if (command === "toggle-sidebar") toggleFolded();
    });
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === "\\") { e.preventDefault(); toggleFolded(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFolded]);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [newPlaylistDescription, setNewPlaylistDescription] = useState("");

  // `connected` stays true across snapshot → live; refresh on that transition too.
  const loadPlaylists = useCallback((force = false) => {
    if (!connected) return;
    fetchPlaylistSummaries({ force })
      .then((items: PlaylistSummary[]) => { setPlaylists(items); setLoaded(true); })
      .catch((error: unknown) => {
        console.error("Error loading playlists:", error);
      });
  }, [connected, connection.state, snapshotReads]);


  useEffect(() => {
    if (connected) {
      loadPlaylists(true);
    }
  }, [connected, loadPlaylists]);

  useEffect(() => {
    const handler = () => loadPlaylists(true);
    window.addEventListener("playlists-changed", handler);
    window.addEventListener("focus", handler);
    window.addEventListener("online", handler);
    return () => {
      window.removeEventListener("playlists-changed", handler);
      window.removeEventListener("focus", handler);
      window.removeEventListener("online", handler);
    };
  }, [loadPlaylists]);

  const createPlaylist = async () => {
    if (!newPlaylistName.trim()) return;
    try {
      const res = await fetch(apiUrl("/api/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newPlaylistName.trim(), description: newPlaylistDescription.trim() } satisfies SchemaPlaylistCreateRequest),
      });
      if (res.ok) {
        setNewPlaylistName("");
        setNewPlaylistDescription("");
        setShowCreateForm(false);
        window.dispatchEvent(new Event("playlists-changed"));
      }
    } catch (err) {
      console.error("Error creating playlist:", err);
    }
  };

  return (
    // The shell's width springs between 240 and 76 px (sidebar.css) and clips;
    // the sidebar inside keeps its 240 px, so icons and covers never move —
    // only their labels fade. The tab sits outside the clip, on the edge.
    <div className="sidebar-shell" data-folded={folded ? "" : undefined}>
    <div className="sidebar-shell__clip">
    <div style={{ containerType: "size", containerName: "sidebar" }} className="sidebar-layout flex h-full min-h-0 w-[240px] flex-col bg-[var(--panel)] p-4 gap-3.5 shrink-0">
      {/* macOS: the window's buttons sit above the logo, in a strip that
          drags the window like a title bar would (WindowControls.tsx). */}
      {hasCustomWindowControls() ? (
        <div data-tauri-drag-region className="-mx-4 -mt-4 -mb-3 px-5 pt-3 pb-1">
          <WindowControls />
        </div>
      ) : null}
      {/* Logo / Brand – the Flipspin mark + name */}
      <div className="flex items-center gap-2.5">
        {/* The app icon, same artwork as the Dock (resources/icon/). */}
        <img src={krobiMark} alt="" width={28} height={28} className="sb-logo h-7 w-7 rounded-control border-[1.5px] border-black shrink-0 object-cover" />
        <span className="sb-fade font-extrabold text-base tracking-tight shrink-0 flex-1">{APP_NAME}</span>
        <button
          type="button"
          onClick={toggleFolded}
          tabIndex={folded ? -1 : 0}
          title={`${t("Hide the sidebar")} · ⌘\\`}
          aria-label={t("Hide the sidebar")}
          aria-expanded={!folded}
          className={`sb-fade ${BARE_ICON}`}
          style={BARE_STYLE}
        >
          <PanelLeft className="w-[17px] h-[17px]" aria-hidden />
        </button>
      </div>

      {/* Main Navigation */}
      <nav className="flex flex-col gap-1">
        {SIDEBAR_PAGES.map((id) => <NavItem key={id} disabled={offline && id === "dashboard"} title={offline && id === "dashboard" ? t("Explore requires the nest") : undefined} color={PAGES[id].color} icon={NAV_ICONS[id]} label={t(PAGES[id].title)} active={activePage === id} folded={folded} onClick={() => setActivePage(id)} />)}
        {pluginPages.map((p) => <NavItem key={p.id} color={p.color} label={t(p.title)} active={activePage === p.id} folded={folded} onClick={() => setActivePage(p.id)} />)}
        {/* Personal scope belongs in Library's toolbar because saved tracks remain part of the shared catalog. */}
        {/* "Import" is no longer a page: the Spotify-export wizard is a tab
            inside Settings → Library (settings/). */}
        <NavItem
          color="var(--green)"
          icon={NAV_ICONS.settings}
          label={t("Settings")}
          active={activePage === "settings"}
          folded={folded}
          onClick={() => window.dispatchEvent(new CustomEvent("krobi-show-settings", { detail: { section: null } }))}
        />
      </nav>

      {/* Playlists Section */}
      {/* 3px wider than the column on each side (clipped box), so a row's hover
          highlight, which hangs 3px outside the covers, is not cut off. */}
      <div className="flex flex-col gap-1 flex-1 min-h-0 overflow-hidden pt-3 border-t border-black/10 -mx-[3px] px-[3px]">
        <div className="sb-fade flex items-center justify-between">
          {/* The heading is the way to the grid of every list; a list below it
              opens that list directly, as a page of its own. */}
          <button
            type="button"
            onClick={() => {
              setSelectedPlaylistName?.(null);
              setActivePage("playlists");
            }}
            title={t("All playlists")}
            aria-current={activePage === "playlists" && !selectedPlaylistName ? "page" : undefined}
            className="sidebar-section-link text-[11px] font-bold uppercase tracking-[0.06em]"
            style={{ fontFamily: "var(--font-pixel)" }}
          >
            {t("Playlists")}
          </button>
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => { setListCollapsed(false); setShowCreateForm((v) => !v); }}
              title={t("New playlist")}
              aria-label={t("New playlist")}
              className={BARE_ICON}
              style={BARE_STYLE}
            >
              <Plus className="w-4 h-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={toggleList}
              title={listCollapsed ? t("Show playlists") : t("Hide playlists")}
              aria-label={listCollapsed ? t("Show playlists") : t("Hide playlists")}
              aria-expanded={!listCollapsed}
              className={BARE_ICON}
              style={BARE_STYLE}
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${listCollapsed ? "-rotate-90" : ""}`} aria-hidden />
            </button>
          </span>
        </div>
        {showCreateForm && !listCollapsed && !folded && (
          <div className="flex flex-col gap-2 px-2 py-2 border-b border-gray-200 mb-2">
            <input
              type="text"
              placeholder={t("Playlist name")}
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              className="text-sm px-2 py-1.5 border border-gray-400 rounded bg-white text-black focus:outline-none focus:border-black"
            />
            <input
              type="text"
              placeholder={t("Description (optional)")}
              value={newPlaylistDescription}
              onChange={(e) => setNewPlaylistDescription(e.target.value)}
              className="text-sm px-2 py-1.5 border border-gray-400 rounded bg-white text-black focus:outline-none focus:border-black"
            />
            <div className="flex gap-2">
              <button type="button" onClick={createPlaylist} disabled={!newPlaylistName.trim()} className="px-2 py-1 text-sm font-medium bg-black text-white rounded hover:bg-gray-800 disabled:opacity-50">
                {t("Create")}
              </button>
              <button type="button" onClick={() => setShowCreateForm(false)} className="px-2 py-1 text-sm border border-gray-400 rounded hover:bg-gray-100">
                {t("Cancel")}
              </button>
            </div>
          </div>
        )}
        <div hidden={listCollapsed} className="sidebar-playlists-scroll -mx-[3px] flex flex-col overflow-y-auto pb-1 min-h-0">
          {playlists.length > 0
            ? playlists.map((playlist, index) => {
                const rawName = typeof playlist === "object" && playlist != null ? playlist.name : String(playlist);
                const name = rawName ?? "Playlist";
                return (
                  <PlaylistItem
                    key={name ?? `playlist-${index}`}
                    name={name}
                    covers={playlistCovers(playlist)}
                    count={playlistCount(playlist)}
                    duration={playlistDuration(playlist)}
                    onClick={() => {
                      setSelectedPlaylistName?.(name);
                      setActivePage("playlists");
                    }}
                    // Lit only while Playlists is the page on screen. The name is
                    // kept either way, so coming back to Playlists reopens it.
                    isSelected={activePage === "playlists" && selectedPlaylistName === name}
                    folded={folded}
                    play={playlistCount(playlist) === 0 ? undefined : {
                      onPlay: () => playPlaylist(name),
                      current: source?.kind === "playlist" && source.name === name,
                      playing: isPlaying,
                      onToggle: () => setIsPlaying(!isPlaying),
                    }}
                  />
                );
              })
            : folded ? null : (
                // A folded rail has no room for words; the empty line would only show clipped.
                <div className="sb-fade text-xs text-ink-3 px-2 py-1">{loaded ? t("No playlists") : <ContentPlaceholder compact />}</div>
              )}
        </div>
      </div>


      {/* The Ising screen at the bottom (shared/IsingScreen). */}
      <div className="sb-fade sidebar-ising mt-auto shrink-0 w-full">
        <IsingScreen />
      </div>

    </div>
    </div>
    {folded && (
      <button type="button" className="sidebar-shell__tab" onClick={toggleFolded}
        title={`${t("Show the sidebar")} · ⌘\\`} aria-label={t("Show the sidebar")} aria-expanded={false}>
        <ChevronRight className="w-[13px] h-[13px]" strokeWidth={2.75} aria-hidden />
      </button>
    )}
    </div>
  );
}
