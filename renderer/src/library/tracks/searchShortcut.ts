/**
 * ⌘K / Ctrl+K: focus the shell's library search first, then a page field
 * when the shell is absent (an embedded list, for example).
 *
 * Each search field registers itself while mounted; the most recent one is
 * the one on screen. When none is (Home, the playlist grid, a browse page),
 * App navigates to the library and asks for focus *before* its field exists,
 * so the request is held until the next field registers.
 */
import { useEffect, type RefObject } from "react";

const fields: HTMLInputElement[] = [];
let globalField: HTMLInputElement | null = null;
// When the held request was made. It expires, so a library that never drew
// its field (backend offline) cannot steal focus minutes later.
let pendingAt = 0;
const PENDING_MS = 2000;

function focusField(el: HTMLInputElement) {
  el.focus();
  el.select();
}

/** Focus the search field on screen. False when there is none to focus. */
export function focusSearch(): boolean {
  const el = globalField || fields[fields.length - 1];
  if (!el) return false;
  focusField(el);
  return true;
}

/** Focus the next search field to mount (the page App is navigating to). */
export function focusSearchWhenReady() {
  pendingAt = Date.now();
}

export function isSearchShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key?.toLowerCase() === "k";
}

export { SEARCH_SHORTCUT_LABEL } from '../../lib/searchShortcutLabel';

/** Make this input the target of ⌘K while it is mounted. */
export function useSearchShortcutTarget(ref: RefObject<HTMLInputElement | null>, priority?: "global") {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    fields.push(el);
    if (priority === "global") globalField = el;
    if (pendingAt && Date.now() - pendingAt < PENDING_MS) focusField(el);
    pendingAt = 0;
    return () => {
      const i = fields.lastIndexOf(el);
      if (i >= 0) fields.splice(i, 1);
      if (globalField === el) globalField = null;
    };
  }, [ref, priority]);
}
