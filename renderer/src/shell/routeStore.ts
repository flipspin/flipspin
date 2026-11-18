/** Store top-level routes and playlist names in the hash so browser history and reload agree.
 * Browse details use a separate stack. Preserve the open playlist across page changes
 * and return a stable snapshot until the route changes. */
import { useSyncExternalStore } from "react";
import type { Page } from "./pageTable";

export type Route = {
  page: Page;
  /** The playlist Playlists shows (kept while another page is on screen). */
  playlist: string | null;
};

const DEFAULT: Route = { page: "home", playlist: null };
let route: Route = DEFAULT;
const listeners = new Set<() => void>();

function emit(next: Route): void {
  if (next.page === route.page && next.playlist === route.playlist) return;
  route = next;
  listeners.forEach((l) => l());
}

/** `#/playlists/My%20list` → { page: "playlists", playlist: "My list" }. */
export function parseHash(hash: string): Partial<Route> | null {
  const path = hash.replace(/^#\/?/, "");
  if (!path) return null;
  const [savedPage, ...rest] = path.split("/");
  const page = savedPage === "ajustes" ? "settings" : savedPage;
  if (!page) return null;
  const name = rest.length ? safeDecode(rest.join("/")) : null;
  return page === "playlists" ? { page, playlist: name } : { page };
}

export function hashOf(next: Route): string {
  if (next.page === "playlists" && next.playlist) return `#/playlists/${encodeURIComponent(next.playlist)}`;
  return `#/${next.page === "settings" ? "ajustes" : next.page}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function write(next: Route, replace: boolean): void {
  if (typeof window !== "undefined") {
    const hash = hashOf(next);
    if (window.location.hash !== hash) {
      const url = `${window.location.pathname}${window.location.search}${hash}`;
      if (replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
  }
  emit(next);
}

/** Read the route from the address, as the app starts (and after a reload). */
export function initRouteFromLocation(): void {
  const parsed = typeof window === "undefined" ? null : parseHash(window.location.hash);
  route = parsed ? { page: parsed.page ?? "home", playlist: parsed.playlist ?? null } : DEFAULT;
  listeners.forEach((l) => l());
}

/** Go to a page; Playlists reopens the playlist it last showed. */
export function navigate(page: Page, options: { replace?: boolean } = {}): void {
  write({ page: page === "ajustes" ? "settings" : page, playlist: route.playlist }, Boolean(options.replace));
}

/**
 * Choose the playlist Playlists shows (null: its grid). On the Playlists page
 * this is a history step of its own; elsewhere it is only remembered.
 */
export function setPlaylist(name: string | null): void {
  const next = { page: route.page, playlist: name };
  if (route.page === "playlists") write(next, false);
  else emit(next);
}

/** Open a playlist: the Playlists page with it on screen, one history step. */
export function openPlaylist(name: string): void {
  write({ page: "playlists", playlist: name }, false);
}

export function getRoute(): Route {
  return route;
}

export function subscribeRoute(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("popstate", onPop);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("popstate", onPop);
  };
}

// Back / forward: the address is the truth.
function onPop(): void {
  const parsed = parseHash(window.location.hash);
  emit(parsed ? { page: parsed.page ?? "home", playlist: parsed.page === "playlists" ? parsed.playlist ?? null : route.playlist } : DEFAULT);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeRoute, getRoute, getRoute);
}

/** For tests: back to Home with nothing remembered. */
export function _resetRouteForTest(): void {
  route = DEFAULT;
  listeners.forEach((l) => l());
}
