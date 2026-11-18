import { useLayoutEffect, useRef, type RefObject, type UIEvent } from "react";

// Persisted scroll offset for the track table. Lives at module scope so it
// survives the panel unmounting when the user navigates to another page and
// back (App renders the Library page conditionally on `activePage`).
const persistedScroll = { top: 0 };

/** Where the list was left: the virtual list starts there (SongRows). */
export function savedScrollTop(): number {
  return persistedScroll.top;
}

/**
 * Restore the saved scroll position once, after the list has rendered enough
 * rows to actually scroll there. On remount (page revisit) this runs again
 * because it's a fresh component instance. Returns the `onScroll` that saves it.
 */
export function usePersistedScroll(scrollRef: RefObject<HTMLElement | null>) {
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || restoredRef.current) return;
    if (persistedScroll.top <= 0 || el.scrollHeight > el.clientHeight) {
      el.scrollTop = persistedScroll.top;
      restoredRef.current = true;
    }
  });
  return (e: UIEvent<HTMLElement>) => {
    persistedScroll.top = e.currentTarget.scrollTop;
  };
}
