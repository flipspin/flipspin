import { focusManager } from '@tanstack/react-query'
import { watchChanges } from '../data/changeListeners'
/**
 * Owns the current backend identity as a module singleton shared across navigation.
 * Components and non-React library stores read the same GET /api/me result.
 * getState() must retain object identity between mutations for useSyncExternalStore.
 * Only source === "token" supports personal library rows; synthetic owners do not.
 * Refresh on credential changes and distinguish unauthorized, legacy and offline states.
 */
import type { ApiData } from "../data/http";

export type Identity = ApiData<"/api/me", "get">;
export interface IdentityState {
  status: "loading" | "ready" | "unauthorized" | "legacy" | "offline";
  me: Identity | null;
  error: string;
}

import { useSyncExternalStore } from "react";
import { apiUrl } from "../lib/api";
import { subscribeToken } from "../lib/authToken";
import i18n from "../i18n";

const listeners = new Set<() => void>();
let loaded = false;
let needsRefresh = false;
let revision = 0;
let inFlight: Promise<IdentityState> | null = null;

/** Distinguish pending identity, valid identity, rejected credentials, unsupported routes
 * and network failure so each state offers the appropriate recovery. */
let state: IdentityState = { status: "loading", me: null, error: "" };

function set(patch: Partial<IdentityState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getState() {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Lazy first load: the store answers the first component that asks rather
  // than firing at import time, when there may be no backend up yet.
  if (!loaded) load();
  return () => listeners.delete(listener);
}

/** Retry offline identity reads so startup and wake-time network failures can recover.
 * Other states wait for a credential or server change; repeated requests cannot resolve them. */
let retryTimer: (() => void) | null = null;

function stopRetrying() {
  if (retryTimer === null) return;
  retryTimer();
  retryTimer = null;
}

/** Enter `offline` and keep asking until it stops being true. */
function goOffline(error: string) {
  set({ status: "offline", error });
  if (retryTimer !== null || typeof window === "undefined") return;
  retryTimer = watchChanges(['me:<account>', 'signin'], () => {
    if (state.status !== 'offline') { stopRetrying(); return; }
    return load();
  }, false);
}

export async function load(): Promise<IdentityState> {
  loaded = true;
  if (!focusManager.isFocused()) { needsRefresh = true; return state; }
  needsRefresh = false;
  if (inFlight) return inFlight;
  // Keep the previous identity on screen while re-checking; a flash of
  // "loading" on every token refresh is noise, not information.
  if (!state.me) set({ status: "loading", error: "" });

  const version = revision;
  inFlight = (async () => {
    try {
      const response = await fetch(apiUrl("/api/me")!);
      if (version !== revision) return state;
      if (response.status === 401 || response.status === 403) {
        set({ status: "unauthorized", me: null, error: "" });
        return state;
      }
      if (response.status === 404) {
        set({ status: "legacy", me: null, error: "" });
        return state;
      }
      const data: Identity | null = await response.json().catch(() => null);
      if (version !== revision) return state;
      if (!response.ok || !data) {
        goOffline(i18n.t("The identity couldn't be read."));
        return state;
      }
      set({ status: "ready", me: data, error: "" });
      return state;
    } catch (error) {
      if (version !== revision) return state;
      goOffline(String(error && typeof error === "object" && "message" in error ? error.message || error : error));
      return state;
    } finally {
      if (version === revision) inFlight = null;
    }
  })();

  return inFlight;
}

/* -------------------------------------------------------------- selectors */

/** May hold library rows. See the capability note in the file header. */
export function isRealUser(snapshot = state) {
  return snapshot.status === "ready" && snapshot.me?.source === "token";
}

export function useIdentity() {
  return useSyncExternalStore(subscribe, getState, getState);
}

// A new credential is a new identity; re-ask rather than assume the answer
// carried over.
if (typeof window !== "undefined") {
  subscribeToken(() => {
    revision++;
    inFlight = null;
    stopRetrying();
    if (loaded) load();
  });

  // Retry on wake or focus so recovered connectivity does not wait for the interval.
  const askAgainIfOffline = () => {
    if (loaded && state.status === "offline") void load();
  };
  let previousFocus = focusManager.isFocused();
  focusManager.subscribe(focused => {
    const regained = !previousFocus && focused;
    previousFocus = focused;
    if (regained && loaded && (needsRefresh || state.status === "offline" || state.status === "loading")) void load();
  });
  window.addEventListener("online", askAgainIfOffline);
}
