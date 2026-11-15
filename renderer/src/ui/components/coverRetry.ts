// Mounted tiles share one recovery signal and focus listener. Callbacks only
// update failed images, so healthy covers do not re-render on recovery signals.
const listeners = new Set<() => void>();
let backendOnline = false;

function signal() {
  for (const listener of listeners) listener();
}

/** App forwards its existing bridge-backed state; covers never probe or fetch. */
export function setCoverBackendOnline(online: boolean) {
  const reconnected = online && !backendOnline;
  backendOnline = online;
  // Repeated healthy shell statuses must not restart a missing cover's budget.
  if (reconnected) signal();
}

export function subscribeCoverRetry(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener("focus", signal);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("focus", signal);
    }
  };
}
