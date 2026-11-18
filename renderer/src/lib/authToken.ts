/**
 * Owns the current API token and notifies subscribers when it changes.
 * Read getApiToken() at request time; capturing it at module scope freezes authentication.
 * The native shell owns persisted credentials and distributes changes across windows.
 * An empty token clears authentication and must propagate like any other value.
 * One failing subscriber must not prevent the remaining subscribers from updating.
 */

function seed(): string {
  if (typeof window !== "undefined" && window.desktopAPI?.backendToken) {
    return String(window.desktopAPI.backendToken).trim();
  }
  try {
    return (import.meta.env?.VITE_API_TOKEN || "").trim();
  } catch {
    // Not a Vite build (a test runner, say). No token is a valid state.
    return "";
  }
}

let current = seed();
const listeners = new Set<(token: string) => void>();

/** The token to use *right now*. Ask at request time, never before. */
export function getApiToken() {
  return current;
}

/** Empty string is a real value: it means "no credential", not "unchanged". */
export function setApiToken(next: string | null | undefined) {
  const value = (next || "").trim();
  if (value === current) return current;
  current = value;
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      // One bad subscriber must not stop the others from learning that the
      // credential changed; a store left on a dead token is worse than a log.
      console.error("authToken subscriber failed:", error);
    }
  }
  return current;
}

/** Returns a disposer, matching the `on*` convention in preload.cjs. */
export function subscribeToken(listener: (token: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Subscribe before reading: bootstrap may have raced a change in another window.
if (typeof window !== "undefined" && window.desktopAPI?.onAuthChanged) {
  const desktop = window.desktopAPI;
  let revision = 0;
  const refresh = async () => {
    const before = ++revision;
    try {
      const auth = await desktop.getAuthToken();
      if (before === revision) setApiToken(auth.token);
    } catch (error) {
      console.error("Could not refresh desktop authentication:", error);
    }
  };
  desktop.onAuthChanged(() => { void refresh(); });
  void refresh();
}
