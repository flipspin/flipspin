/** A page owns its header override until it unmounts. */
import { useLayoutEffect, useSyncExternalStore } from "react";

export type HeaderStrip = {
  name: string;
  coverUrl: string | null;
  color: string;
  ink: string;
  play: (() => void) | null;
  collapsed: boolean;
};
export type HeaderTitle = string | HeaderStrip | null;

export const HEADER_HEIGHT_PX = 58;

/** Today's date follows the UI language, shared by the page and its bar. */
export function todayLabel(locale: string): string {
  try {
    const date = new Date().toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
    return date.charAt(0).toUpperCase() + date.slice(1);
  } catch {
    return "";
  }
}
let title: HeaderTitle = null;
const listeners = new Set<() => void>();

export function setHeaderTitle(next: HeaderTitle): void {
  if (next === title) return;
  title = next;
  listeners.forEach(l => l());
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useHeaderTitleOverride(): HeaderTitle {
  return useSyncExternalStore(subscribe, () => title, () => title);
}
/** Layout timing lets restored pages publish the strip before first paint. */
export function useHeaderTitle(next: HeaderTitle): void {
  useLayoutEffect(() => {
    setHeaderTitle(next);
    return () => setHeaderTitle(null);
  }, [next]);
}
