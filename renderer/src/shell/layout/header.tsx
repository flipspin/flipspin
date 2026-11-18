import type { ShellSettings, ShellLibrary } from "../shell.types";
import { useForcedOffline, setForcedOffline } from "../../offline/mode";
import { hasBridge } from "../../bridge";
import { pageTitle } from "../pageTable";
import type { TFunction } from "i18next";
import type { CurrentUser } from "../../data/hooks/use-current-user";
import type { LibraryAlbums } from "../../data/hooks/use-library-albums";
import type { LucideIcon } from "lucide-react";
import React from "react";
import { ArrowLeft, Check, ChevronDown, Menu, Moon, PanelRightClose, PanelRightOpen, Play, RefreshCw, Server, Settings, Sparkles, Sun, User } from "lucide-react";
import { useSettings } from "@state/SettingsContext";
import { useLibrary } from "@state/LibraryContext";
import DownloadsMenu from "../../downloads/DownloadsMenu";
// Which server this app is talking to; see shell/ServerBadge.tsx. Two Flipspin
// installs on one network look identical once a library loads, and the
// difference decides whose library it is.
import { openSettings, useNestStatus } from "../ServerBadge";
import { artColorFor, initials } from "../../ui/components/cardArt";
import { useCurrentUser } from "../../data";
import { useSyncExternalStore } from "react";
import {
  back as browseBack,
  currentRoute,
  getState as browseState,
  routeTitle,
  subscribe as browseSubscribe,
} from "../../browse/navigationStore";
import { APP_NAME } from "../../brand";
import { useTranslation } from "react-i18next";
import { msg } from "../../i18n";
import WindowControls, { hasWindowsCaption, WindowsCaption } from "./WindowControls";
import LibrarySearchBox from "../../library/search/LibrarySearchBox";
import { useExploreRefresh } from "../../library/search/topSearchState";
import { useAttention } from "../../attention/useAttention";
import { AccountAttention, AttentionDot } from "../../attention/AccountAttention";
import { Popover } from "../../ui/react/components/Popover";
import { attentionLabel } from "../../attention/words";
import { HEADER_HEIGHT_PX, todayLabel, useHeaderTitleOverride } from "../headerTitle";
import { useHomeRailState, useHomeRailShortcut, toggleHomeRail } from "../../home/useHomeRail";
import { useFloatingHeaderLayout } from "../useFloatingHeaderLayout";
import { useShellScroll } from "../useShellScroll";
import "./topbar.css";

/** Light and Dark retain the selected palette; Night uses the night palette. */
const MODE_OPTIONS = [
  { id: "light", label: msg("Light"), Icon: Sun },
  { id: "dark", label: msg("Dark"), Icon: Moon },
  { id: "night", label: msg("Night"), Icon: Sparkles },
];

export function ModeMenu() {
  const { t } = useTranslation();
  const { mode, setMode } = useSettings() as ShellSettings;
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  const current = MODE_OPTIONS.find((o) => o.id === mode) || MODE_OPTIONS[0];
  const CurrentIcon = current.Icon;
  return (
    <div className="relative shrink-0">
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Appearance: {{mode}}", { mode: t(current.label) })}
        title={t("Appearance")}
        className="topbar-control topbar-control--icon"
      >
        <CurrentIcon size={17} strokeWidth={2.25} aria-hidden />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        role="menu"
        className="min-w-[210px] p-1.5 bg-panel border-2 border-black rounded-[10px] shadow-[var(--shadow-pop-lg)]"
      >
          {MODE_OPTIONS.map(({ id, label, Icon }) => (
            <div
              key={id}
              role="menuitemradio"
              aria-checked={mode === id}
              tabIndex={0}
              onClick={() => { setMode(id); setOpen(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMode(id); setOpen(false); } }}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-control cursor-pointer text-[13.5px] font-semibold text-[var(--ink)] hover:bg-[var(--paper)] ${mode === id ? "bg-[var(--paper)]" : ""}`}
            >
              <Icon size={15} strokeWidth={2.25} aria-hidden />
              <span>{t(label)}</span>
              {mode === id && <Check size={14} strokeWidth={3} className="ml-auto" aria-hidden />}
            </div>
          ))}
      </Popover>
    </div>
  );
}

/**
 * Who this install is signed in as, and which nest it is talking to; one
 * block, the way a header carries an account: a square avatar, the name, and
 * under it the nest's dot and address. No pill frame; it is part of the bar.
 * A click drops the account menu: who, where, and the doors to both.
 */
export function AccountBlock({ name, account }: { name: string; account: Partial<CurrentUser> }) {
  const { t } = useTranslation();
  const nest = useNestStatus();
  const forced = useForcedOffline();
  const [open, setOpen] = React.useState(false);
  const owner = account?.isOwner === true || account?.role === "owner";
  const attention = useAttention(owner, open);
  const ref = React.useRef<HTMLButtonElement>(null);
  const go = (section: string | null) => { setOpen(false); openSettings(section as string | undefined); };
  const role = account?.isOwner || account?.role === "owner" ? t("Owner") : account?.role ? t("Standard") : "";
  const avatar = (size: string, text: number) => (
    <span
      aria-hidden
      className={`grid place-items-center shrink-0 ${size} rounded-control border-2 border-black font-bold`}
      style={{ background: artColorFor(name), color: "#151515", fontFamily: "var(--font-display)", fontSize: text }}
    >
      {initials(name)}
    </span>
  );
  const Item = ({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) => (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className="flex items-center gap-2.5 px-2.5 py-2 rounded-control cursor-pointer text-[13.5px] font-semibold text-[var(--ink)] hover:bg-[var(--paper)] focus-visible:bg-[var(--paper)] outline-none"
    >
      <Icon size={15} strokeWidth={2.25} aria-hidden className="text-[var(--ink-3)]" />
      {label}
    </div>
  );

  return (
    <div className="relative min-w-0">
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={nest.hint ? `${name} · ${nest.hint}` : name}
        aria-label={[t("{{name}}, nest: {{nest}}", { name, nest: nest.label }), attentionLabel(attention.data, t)].filter(Boolean).join(", ")}
        className={`app-account__trigger group flex items-center gap-2.5 min-w-0 max-w-[30vw] h-11 pl-1 pr-2 rounded-panel border-0 shadow-none text-left cursor-pointer hover:bg-[var(--paper-2)] ${open ? "bg-[var(--paper-2)]" : "bg-transparent"}`}
      >
        <span className="relative shrink-0">{avatar("w-9 h-9", 12)}<AttentionDot value={attention.data} /></span>
        <span className="app-account__label flex flex-col min-w-0 leading-tight">
          <span className="truncate text-[13.5px] font-bold text-[var(--ink)]">{name}</span>
          <span className="flex items-center gap-1.5 min-w-0 font-mono text-[11px] text-[var(--ink-3)]">
            <span aria-hidden className="w-2 h-2 shrink-0 rounded-full" style={{ background: nest.color }} />
            <span className="truncate">{nest.label}</span>
          </span>
        </span>
        <ChevronDown size={14} strokeWidth={2.5} aria-hidden className={`app-account__chevron shrink-0 text-[var(--ink-3)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        role="menu"
        aria-label={name}
        className={`${owner ? "w-[340px]" : "w-[280px]"} max-w-[calc(100vw-24px)] bg-panel border-2 border-black rounded-[10px] shadow-[var(--shadow-pop-lg)]`}
      >
          <div className="flex items-center gap-3 p-3">
            {avatar("w-11 h-11", 15)}
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="truncate text-[15px] font-bold text-[var(--ink)]">{name}</span>
              {role && <span className="truncate text-[12px] text-[var(--ink-3)]">{role}</span>}
            </div>
          </div>
          <div className="mx-3 mb-2 px-2.5 py-2 rounded-control bg-[var(--paper)] flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 min-w-0 font-mono text-[12px] font-semibold text-[var(--ink)]">
              <span aria-hidden className="w-2 h-2 shrink-0 rounded-full" style={{ background: nest.color }} />
              <span className="truncate">{nest.label}</span>
            </span>
            {nest.hint && <span className="text-[11.5px] leading-snug text-[var(--ink-3)]">{nest.hint}</span>}
          </div>
          {owner && <AccountAttention value={attention.data} go={go} retry={() => void attention.refetch()} busy={attention.isFetching} />}
          <div className="border-t-2 border-[var(--line-soft)] p-1.5">
            {hasBridge() && <div role="menuitemcheckbox" aria-checked={forced} tabIndex={0} className="flex items-center gap-2.5 px-2.5 py-2 rounded-control cursor-pointer text-[13.5px] font-semibold hover:bg-[var(--paper)]" onClick={() => { void setForcedOffline(!forced); setOpen(false); }} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void setForcedOffline(!forced); setOpen(false); } }}>{forced && <Check size={15} aria-hidden />}{t("Offline mode")}</div>}
            <Item icon={User} label={t("My account")} onClick={() => go("cuenta")} />
            <Item icon={Server} label={t("Nest")} onClick={() => go("servidor")} />
            <Item icon={Settings} label={t("Settings")} onClick={() => go(null)} />
          </div>
      </Popover>
    </div>
  );
}

/** Content header (design "Mesa" main header): page title (Inter, --font-main) + today's date (Geist Mono),
 *  with a collection pill on the right. Also the frameless-window drag region and the
 *  mobile menu trigger. The transport lives in the bottom bar (FixedBottomPlayerBar). */
// Derive a fallback display name from the account segment of the music path.
function userFromPath(path: string | null | undefined) {
  const parts = (path || "").split("/").filter(Boolean);
  const i = parts.findIndex((p) => p.toLowerCase() === "users" || p.toLowerCase() === "home");
  const raw = i >= 0 ? parts[i + 1] : parts[0];
  if (!raw) return "";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Format collection counts and nouns in the current UI language.
function libraryStats(albums: (LibraryAlbums[number] & { trackCount?: number })[], t: TFunction, locale: string) {
  const albumCount = albums.length;
  const trackCount = albums.reduce((n, a) => n + (a?.tracks?.length ?? a?.trackCount ?? 0), 0);
  if (!albumCount) return "";
  const fmt = (n: number) => n.toLocaleString(locale);
  const songs = t("{{n}} songs", { count: trackCount, n: fmt(trackCount) });
  const records = t("{{n}} albums", { count: albumCount, n: fmt(albumCount) });
  return `${songs} · ${records}`;
}

export default function Header({ activePage = "home", onMenuClick = undefined, albums = [], portrait = false, openPlaylist = null }: { activePage?: string; onMenuClick?: () => void; albums?: LibraryAlbums; portrait?: boolean; openPlaylist?: string | null }) {
  const { baseDir } = useLibrary() as ShellLibrary;
  const { t, i18n } = useTranslation();
  useSyncExternalStore(browseSubscribe, browseState);
  const route = currentRoute();
  const exploreRefresh = useExploreRefresh();
  const floating = useFloatingHeaderLayout(activePage, route?.kind, portrait);
  const railAvailable = !route && activePage === "home" && floating;
  const railFolded = useHomeRailState();
  useHomeRailShortcut(railAvailable);
  const railLabel = railFolded ? t("Show the side column") : t("Hide the side column");

  // `pageTitle` (pageTable.tsx) is an exact-match lookup, so a parameterised
  // route would fall through to "Flipspin". Routes therefore carry their own title.
  // An open playlist names itself here: "Playlists · Monday, October 5" said
  // nothing about the page under it.
  const playlistOpen = !route && activePage === "playlists" && openPlaylist;
  // A page can name itself instead (shell/headerTitle.ts: useHeaderTitle).
  const override = useHeaderTitleOverride();
  const headerRef = React.useRef<HTMLElement>(null);
  const pageKey = JSON.stringify([activePage, openPlaylist, route]);
  useShellScroll(headerRef, pageKey, floating);
  const strip = playlistOpen && override && typeof override === "object" ? override : null;
  const title = route
    ? routeTitle(route)
    : typeof override === "string"
    ? override
    : playlistOpen
      ? t("Playlists")
      : (pageTitle(activePage) ? t(pageTitle(activePage)!) : APP_NAME);
  // On the library page surface the collection size; elsewhere show today's date.
  const stats = !route && activePage === "albums" ? libraryStats(albums, t, i18n.language) : "";
  const meta = playlistOpen ? "" : stats || todayLabel(i18n.language);
  // Use account identity for this label; the server data path can name a service account.
  const me = useCurrentUser();
  const account: Partial<CurrentUser> = me.data || {};
  const collection = account.username || account.label || userFromPath(baseDir) || t("My collection");

  return (
    <header
      ref={headerRef}
      // Tauri, not Electron: WebKit ignores `-webkit-app-region`. `deep` makes
      // the whole subtree a drag handle; buttons and links opt out on their
      // own, anything else interactive says `data-tauri-drag-region="false"`.
      // Needs `core:window:allow-start-dragging` in capabilities/default.json.
      data-tauri-drag-region="deep"
      data-floating={floating ? "" : undefined}
      className={`app-header ${portrait ? "app-header--portrait" : ""} flex items-center justify-between shrink-0 w-full gap-3`}
      // With the window's own buttons at the right edge, they sit flush against it.
      style={{ "--header-height": `${HEADER_HEIGHT_PX}px`, background: "var(--panel)", paddingLeft: 16, paddingRight: hasWindowsCaption() ? 0 : 16, boxSizing: "border-box" } as React.CSSProperties}
    >
      <div className="app-header__leading flex items-center min-w-0 gap-3">
        {/* With the sidebar folded into a drawer, the window buttons ride
            the header instead (the sidebar strip is off screen). */}
        <WindowControls className={`${portrait ? "" : "md:hidden"} mr-1`} />
        {/* Hamburger opens the nav drawer: on narrow windows, and in portrait
            at any width, where the sidebar is a drawer too (App.tsx). The tab
            bar covers the pages; this is the way to the playlist list. */}
        <button
          type="button"
          onClick={onMenuClick}
          aria-label={t("Open menu")}
          title={t("Menu")}
          className={`${portrait ? "" : "md:hidden"} flex items-center justify-center w-9 h-9 p-0 shrink-0 rounded-control border-2 border-black bg-panel shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-x-0.5 active:translate-y-0.5 active:shadow-none`}
        >
          <Menu size={18} color="var(--dm-ink, #1a1a1a)" />
        </button>
        {/* Back out of a browse route. A <button> is exempt from the drag
            region by itself, so the click reaches it. */}
        {route ? (
          <button
            type="button"
            onClick={browseBack}
            aria-label={t("Back_return")}
            title={t("Back_return")}
            // p-0 is load-bearing: the global base-button rule in index.css applies
            // padding 8px 16px, which leaves a 36px border-box button exactly 0px
            // of content width and collapses the icon to nothing.
            className="flex items-center justify-center w-9 h-9 p-0 shrink-0 rounded-control border-2 border-black bg-panel shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
          >
            <ArrowLeft size={18} color="var(--dm-ink, #1a1a1a)" />
          </button>
        ) : null}
        <div className={`app-header__title flex items-baseline min-w-0 gap-3 ${strip ? "playlist-header-slot" : ""}`} data-collapsed={strip?.collapsed || undefined}>
          {strip && <div className="playlist-header-strip" aria-hidden={!strip.collapsed} inert={!strip.collapsed}>
            <span className="playlist-header-strip__cover" style={{ background: strip.color, color: strip.ink }} aria-hidden>
              {strip.coverUrl ? <img src={strip.coverUrl} alt="" /> : initials(strip.name)}
            </span>
            <span className="truncate">{strip.name}</span>
            <button type="button" className="playlist-header-strip__play" style={{ background: strip.color, color: strip.ink }} disabled={!strip.play} onClick={strip.play ?? undefined} aria-label={t("Play {{name}}", { name: strip.name })} title={t("Play")}><Play size={18} fill="currentColor" strokeWidth={0} aria-hidden /></button>
          </div>}
          <h1 className="truncate" aria-hidden={strip?.collapsed || undefined} style={{ margin: 0, fontFamily: "var(--font-main)", fontWeight: 800, fontSize: floating ? 28 : 22, letterSpacing: "-0.02em", color: "var(--dm-ink, #151515)" }}>
            {title}
          </h1>
          <span className="truncate max-md:hidden" style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-3)" }}>
            {meta}
          </span>
        </div>
      </div>

      <LibrarySearchBox activePage={activePage} albums={albums as React.ComponentProps<typeof LibrarySearchBox>["albums"]} />
      <div className="app-header__actions flex items-center gap-2.5 shrink-0 min-w-0">
        {/* One persistent panel for every job, on every page. */}
        <DownloadsMenu />
        <ModeMenu />
        <span aria-hidden className="self-stretch my-2.5 w-0.5 rounded-full bg-[var(--line-med)]" />
        {railAvailable && <button
          type="button"
          className="topbar-control topbar-control--icon home-rail-toggle"
          aria-label={railLabel}
          aria-expanded={!railFolded}
          aria-controls="home-rail"
          title={`${railLabel} · ⌥⌘\\`}
          onClick={toggleHomeRail}
        >
          {railFolded ? <PanelRightOpen size={18} aria-hidden /> : <PanelRightClose size={18} aria-hidden />}
        </button>}
        {!route && activePage === "dashboard" && <button type="button" className="topbar-control topbar-control--icon"
          disabled={!exploreRefresh || exploreRefresh.loading} aria-label={t("Refresh Explore")}
          title={t("Refresh Explore · updated {{when}}", { when: exploreRefresh?.when || t("Not yet") })}
          onClick={() => exploreRefresh?.run()}>
          <RefreshCw size={17} strokeWidth={2.25} className={exploreRefresh?.loading ? "animate-spin" : undefined} aria-hidden />
        </button>}
        <AccountBlock name={collection} account={account} />
        {hasWindowsCaption() ? <span aria-hidden className="self-stretch my-2.5 w-0.5 rounded-full bg-[var(--line-med)]" /> : null}
        <WindowsCaption />
      </div>
    </header>
  );
}
