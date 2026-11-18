import { useSyncExternalStore } from "react";

const LANDSCAPE = "(min-width: 768px) and (orientation: landscape)";
const subscribe = (listener: () => void) => {
  const query = window.matchMedia?.(LANDSCAPE);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
};
const landscapeNow = () => window.matchMedia?.(LANDSCAPE).matches ?? false;

/** Only these catalog routes and root pages scroll their whole content. */
const CATALOG_ROUTES = ["album", "artist", "playlist", "search"];

export function useFloatingHeaderLayout(activePage = "home", browseKind?: string, portrait = false): boolean {
  const landscape = useSyncExternalStore(subscribe, landscapeNow, () => false);
  const wholePage = browseKind ? CATALOG_ROUTES.includes(browseKind) : activePage === "home" || activePage === "dashboard";
  return landscape && !portrait && wholePage;
}
