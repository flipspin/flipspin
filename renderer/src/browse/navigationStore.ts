/** Keep the browse stack outside React so page unmounts preserve Back history.
 * An empty stack exposes the shell route. Return the same snapshot object
 * until a write: useSyncExternalStore compares by reference. */
import type { LibraryAlbum, LibraryTrack } from "../albums/library.types";
import type { PlayerTrack } from "../state/playerQueue";

type AlbumRef = LibraryAlbum | LibraryTrack | PlayerTrack;
import { pageTransition } from "../ui/react/pageTransition";

import { useSyncExternalStore } from "react";
import i18n, { msg } from "../i18n";

export type Route = { kind: string; provider?: string; id?: string; query?: string; title: string; draft?: string; mode?: "typing" | "full" };
export type RouteEntity = { ref?: { provider?: string; id?: string | number } | null; title?: string | null; name?: string | null };

const initialState: { stack: Route[] } = {
  stack: [],
};

let state = initialState;
const listeners = new Set<() => void>();

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getState() {
  return state;
}

/** Private: the only way state changes. No generic setter is exported. */
function set(patch: Partial<typeof state>, transition = true) {
  state = { ...state, ...patch };
  // State is current at once for readers; only the repaint rides the page transition.
  const notify = () => listeners.forEach((l) => l());
  if (transition) pageTransition(notify); else notify();
}

/** The route currently being shown, or null when the top-level page should be. */
export function currentRoute() {
  return state.stack.length ? state.stack[state.stack.length - 1] : null;
}

/**
 * Push a route on top of whatever is showing.
 *
 * Re-pushing the identical route is ignored: double-clicking a card should not
 * put two copies of the same album on the stack and make Back appear broken.
 */
export function push(route: Route | null | undefined) {
  if (!route || !route.kind) return;
  const top = currentRoute();
  if (top && sameRoute(top, route)) return;
  set({ stack: [...state.stack, route] });
}

/** Replace the top entry rather than stacking on it. */
export function replace(route: Route | null | undefined) {
  if (!route || !route.kind) return;
  if (!state.stack.length) {
    set({ stack: [route] });
    return;
  }
  set({ stack: [...state.stack.slice(0, -1), route] });
}

export function back() {
  if (!state.stack.length) return;
  set({ stack: state.stack.slice(0, -1) });
}

/** Drop the whole stack; what a top-level nav click does. */
export function reset() {
  if (!state.stack.length) return;
  set({ stack: [] });
}

function sameRoute(a: Route, b: Route) {
  return a.kind === b.kind && a.provider === b.provider && a.id === b.id && a.query === b.query && a.mode === b.mode;
}

/* ---------------------------------------------------------------- helpers */

/**
 * Open an album *of the library* (not a catalog album): the album page with
 * its songs on disk. `id` is the album's directory path; what every track
 * of it shares as its parent; so a track alone (a playlist row, the player)
 * can open its album without the album object in hand.
 */
export function openLibraryAlbum(albumOrTrack: AlbumRef | null | undefined, title = "") {
  const dir = albumDirOf(albumOrTrack);
  if (!dir) return;
  push({ kind: "library-album", id: dir, title: title || albumTitleOf(albumOrTrack) });
}

/**
 * Open an artist *of the library*: their albums and songs on disk. Keyed by
 * the name as written (a link passes the tag's primary artist); the page folds
 * case and accents when it matches.
 */
export function openLibraryArtist(name: string) {
  const n = String(name || "").trim();
  if (!n) return;
  push({ kind: "library-artist", id: n, title: n });
}

/** The album directory of an album object (its `path`) or of a track (its file's parent). */
export function albumDirOf(x: AlbumRef | null | undefined) {
  if (!x) return "";
  if ("tracks" in x && Array.isArray(x.tracks)) return String(x.path || "");
  const p = String(x.path || "");
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut > 0 ? p.slice(0, cut) : "";
}

function albumTitleOf(x: AlbumRef | null | undefined) {
  if (!x) return "";
  if ("tracks" in x && Array.isArray(x.tracks)) return (x as LibraryAlbum).album || "";
  return (typeof x.album === "object" ? x.album?.album : x.album) || "";
}

/** Navigate by provider/id; retain the provider URL only for external viewing. */
export function routeFor(entity: RouteEntity | null | undefined, kind: string): Route | null {
  const ref = entity?.ref;
  if (!ref?.provider || !ref?.id) return null;
  return {
    kind,
    provider: ref.provider,
    id: String(ref.id),
    title: entity?.title || entity?.name || "",
  };
}

export function searchRoute(query: string, mode: "typing" | "full" = "full"): Route | null {
  const trimmed = (query || "").trim();
  if (!trimmed) return null;
  return { kind: "search", query: trimmed, draft: query, mode, title: trimmed };
}

/** Typing replaces this search entry; Back still returns to the page it came from. */
export function openLibrarySearch(query: string) {
  if (!query.trim()) {
    if (currentRoute()?.kind === "library-search") set({ stack: state.stack.slice(0, -1) }, false);
    return;
  }
  const route = { kind: "library-search", query, title: "" };
  const stack = currentRoute()?.kind === "library-search" ? state.stack.slice(0, -1) : state.stack;
  // Text entry is synchronous; only explicit page navigation animates.
  set({ stack: [...stack, route] }, false);
}

/** Spanish label for the header, since routes carry their own title. */
// Called at render (header.tsx), so `i18n.t` here answers in the current
// language; a module with no component uses the instance, not the hook.
export function routeTitle(route: Route | null | undefined) {
  if (!route) return null;
  if (route.kind === "library-search") return i18n.t("Search");
  if (route.kind === "search") return i18n.t("Search: {{query}}", { query: route.title });
  return route.title || i18n.t(ROUTE_KIND_TITLES[route.kind] ?? msg("Explore"));
}
const ROUTE_KIND_TITLES: Record<string, string> = { album: msg("Album"), artist: msg("Artist"), playlist: msg("Playlist"), genre: msg("Genre") };

/**
 * True when a browse route is showing. Lives here rather than in
 * `BrowseRouter.jsx` so that file exports only its component.
 */
export function useHasBrowseRoute() {
  const snapshot = useSyncExternalStore(subscribe, getState);
  return snapshot.stack.length > 0;
}

if (typeof window !== "undefined") {
  // A reload should start at the top level rather than resurrecting a stack
  // whose data may no longer be cached.
  window.addEventListener("pagehide", () => {
    state = initialState;
  });
}
