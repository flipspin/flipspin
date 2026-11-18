/** The label the shortcut wears in the UI: ⌘K on a Mac, Ctrl+K elsewhere. */
export const SEARCH_SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "⌘K"
    : "Ctrl+K";
