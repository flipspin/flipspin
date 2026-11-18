import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { History, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePlaylistSummaries } from "@lib/playlistSummaries";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { currentRoute, getState, openLibrarySearch, openLibraryArtist, openLibraryAlbum, push, replace, reset, searchRoute, subscribe } from "../../browse/navigationStore";
import { readScopedSearches, removeScopedSearch, rememberScopedSearch, type SearchScope } from "../../browse/catalogSearchHistory";
import { openPlaylist } from "../../shell/routeStore";
import { SEARCH_SHORTCUT_LABEL, useSearchShortcutTarget } from "../tracks/searchShortcut";
import { decorate, type ListedAlbum } from "../../home/decorateTrack";
import { librarySearchIndex, searchLibrary } from "./librarySearch";
import { registerSearchIndex } from "./topSearchState";
import { useExploreUnavailable } from "./useExploreUnavailable";
import "./library-search.css";

export default function LibrarySearchBox({ albums, activePage = "home" }: { albums: ListedAlbum[]; activePage?: string }) {
  const { t } = useTranslation();
  useSyncExternalStore(subscribe, getState);
  const route = currentRoute();
  const location = JSON.stringify([activePage, route]);
  const startingScope: SearchScope = route ? (["album", "artist", "playlist", "genre", "search"].includes(route.kind) ? "explore" : "library") : activePage === "dashboard" ? "explore" : "library";
  const routeQuery = route?.kind === "library-search" || route?.kind === "search" ? route.draft ?? route.query ?? "" : "";
  // Drafts belong to the current location, never to a remembered global scope.
  const [draft, setDraft] = useState({ location, query: routeQuery, scope: startingScope });
  const { query, scope } = draft.location === location ? draft : { query: routeQuery, scope: startingScope };
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState(readScopedSearches);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const playlists = usePlaylistSummaries();
  const player = useAudioPlayer();
  const unavailable = useExploreUnavailable();
  const index = useMemo(() => librarySearchIndex(albums, playlists), [albums, playlists]);
  useEffect(() => registerSearchIndex(index), [index]);
  const results = useMemo(() => searchLibrary(index, query), [index, query]);
  const matches = useMemo(() => {
    const artists = results.artists.slice(0, 6).map(artist => ({ key: `artist:${artist.name}`, label: artist.name, kind: t("Artist"), open: () => openLibraryArtist(artist.name) }));
    const albums = results.albums.slice(0, 6).map(album => ({ key: `album:${album.path}`, label: album.album || t("Album"), kind: t("Album"), open: () => openLibraryAlbum(album) }));
    const songs = results.songs.slice(0, 6).map(song => ({ key: `song:${song.path}`, label: song.title || song.path, kind: t("Song"), open: () => {
      const queue = results.songs.map(track => decorate(track, track.album));
      const at = results.songs.indexOf(song);
      player.play(queue[at], { replaceQueue: true, upcomingTracks: queue.slice(at + 1), context: queue });
    } }));
    const lists = results.playlists.slice(0, 6).map(playlist => ({ key: `playlist:${playlist.name}`, label: playlist.name, kind: t("Playlist"), open: () => { reset(); openPlaylist(playlist.name); } }));
    // Keep each matching kind represented, then fill with its next ranked hit.
    return Array.from({ length: 6 }, (_, i) => [artists[i], albums[i], songs[i], lists[i]]).flat().filter(Boolean).slice(0, 6);
  }, [results, player, t]);
  const localRows = scope === "library" ? matches : [];
  const typing = Boolean(query.trim());
  const rows = typing ? localRows.length + 1 : recent.length;
  const expanded = focused && rows > 0;
  useSearchShortcutTarget(input, "global");
  useEffect(() => {
    const refresh = () => setRecent(readScopedSearches());
    window.addEventListener("storage", refresh);
    window.addEventListener("search-history-changed", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("search-history-changed", refresh); };
  }, []);
  const change = (value: string, nextScope = scope) => {
    setDraft({ location, query: value, scope: nextScope }); setActive(-1);
  };
  const close = () => { setFocused(false); setActive(-1); input.current?.blur(); };
  const submit = (term: string, nextScope: SearchScope) => {
    if (!term.trim() || (nextScope === "explore" && unavailable)) return;
    rememberScopedSearch(term, nextScope);
    if (nextScope === "explore") {
      const next = searchRoute(term);
      if (route?.kind === "search" || route?.kind === "library-search") replace(next); else push(next);
    } else if (route?.kind === "search") replace({ kind: "library-search", query: term, title: "" });
    else openLibrarySearch(term);
    setDraft({ location: JSON.stringify([activePage, currentRoute()]), query: term, scope: nextScope });
    close();
  };
  const choose = (at: number) => {
    if (!typing) {
      const entry = recent[at];
      if (entry) submit(entry.query, entry.scope);
    } else if (at === localRows.length) submit(query, "explore");
    else if (localRows[at]) { rememberScopedSearch(query, "library"); localRows[at].open(); change(""); close(); }
  };
  const label = scope === "explore" ? t("Search Explore") : t("Search your library");
  return <div ref={root} className="library-search" role="search" data-tauri-drag-region="false" data-open={focused || query ? "" : undefined}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      event.preventDefault(); event.stopPropagation(); change(""); close();
    }}
    onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node)) { setFocused(false); setActive(-1); } }}>
    <div className="library-search__box" title={focused || query ? undefined : `${label} · ${SEARCH_SHORTCUT_LABEL}`}
      onMouseDown={event => { if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof Element && event.target.closest("button"))) { event.preventDefault(); input.current?.focus(); } }}>
      <Search size={16} aria-hidden />
      {scope === "explore" && <span className="library-search__chip">{t("Explore")}</span>}
      <input ref={input} type="search" role="combobox" value={query} aria-label={label}
        aria-keyshortcuts="Meta+K Control+K Meta+Enter" placeholder={label} aria-autocomplete="list" aria-expanded={expanded}
        aria-controls={expanded ? id : undefined} aria-activedescendant={expanded && active >= 0 && active < rows ? `${id}-${active}` : undefined}
        onFocus={() => { setFocused(true); setRecent(readScopedSearches()); setActive(-1); }}
        onChange={event => change(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Backspace" && !query && scope === "explore") { event.preventDefault(); change("", "library"); }
          else if (expanded && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setActive(value => event.key === "ArrowDown" ? (value + 1) % rows : (value <= 0 ? rows : value) - 1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (event.metaKey) submit(query, "explore");
            else if (expanded && active >= 0) choose(active);
            else submit(query, scope);
          }
        }} />
      {query ? <button type="button" className="library-search__clear" aria-label={t("Clear search_delete")}
        title={t("Clear search_delete")} onClick={() => { change(""); input.current?.focus(); }}><X size={14} aria-hidden /></button>
        : <kbd aria-hidden>{SEARCH_SHORTCUT_LABEL}</kbd>}
    </div>
    {expanded && <div className="library-search__popover" onMouseDown={event => event.preventDefault()}>
      <div className="library-search__heading">{typing ? scope === "library" ? t("In your library") : t("In Explore") : t("Recent searches")}</div>
      <ul id={id} role="listbox" aria-label={typing ? scope === "library" ? t("In your library") : t("In Explore") : t("Recent searches")} className="list-none m-0 p-0">
        {typing ? <>
          {localRows.map((row, i) => <li key={row.key} role="option" id={`${id}-${i}`} aria-selected={active === i}
            className="library-search__recent" onMouseMove={() => setActive(i)} onClick={() => choose(i)}>
            <span className="truncate flex-1">{row.label}</span>{" "}<small>{row.kind}</small>
          </li>)}
          <li role="option" id={`${id}-${localRows.length}`} aria-selected={active === localRows.length} aria-disabled={Boolean(unavailable)}
            title={unavailable || undefined} className="library-search__recent library-search__explore" onMouseMove={() => setActive(localRows.length)} onClick={() => submit(query, "explore")}>
            <Search size={14} aria-hidden /><span className="flex-1">{t('Search Explore for "{{query}}"', { query: query.trim() })}</span>
            {unavailable ? <small>{t("Offline")}</small> : <kbd aria-hidden>⌘↵</kbd>}
          </li>
        </> : recent.map((entry, i) => <li key={`${entry.scope}:${entry.query}`} role="option" id={`${id}-${i}`} aria-selected={active === i}
          aria-disabled={entry.scope === "explore" && Boolean(unavailable)} title={entry.scope === "explore" ? unavailable || undefined : undefined}
          className="library-search__recent" onMouseMove={() => setActive(i)} onClick={() => choose(i)}>
          <History size={14} aria-hidden /><span className="truncate flex-1">{entry.query}</span>{" "}<small>{entry.scope === "library" ? t("Library") : t("Explore")}</small>
        </li>)}
      </ul>
      {!typing && <div className="library-search__removals">
        {recent.map(entry => <button key={`${entry.scope}:${entry.query}`} type="button" className="library-search__clear" aria-label={t("Remove search {{query}}", { query: entry.query })}
          title={t("Remove search {{query}}", { query: entry.query })} onClick={event => {
            event.stopPropagation(); setRecent(removeScopedSearch(entry)); setActive(-1); input.current?.focus();
          }}><X size={14} aria-hidden /></button>)}
      </div>}
    </div>}
  </div>;
}
