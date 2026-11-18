/** Share page definitions between the shell, header and sidebar.
 * Translate titles at render time; load Home eagerly and other pages on demand. */
import React, { type ComponentType } from "react";
import { msg } from "../i18n";
import { pluginPages } from "../plugins";
import Home from "../home/home";

export const BUILTIN_PAGES = ["home", "dashboard", "albums", "playlists"] as const;
export type BuiltinPage = (typeof BUILTIN_PAGES)[number];
/**
 * A page is a built-in one or a plugin's (`pluginPages`, whose ids are only
 * known at runtime; hence the `string` arm).
 */
export type Page = BuiltinPage | (string & {});

type PageSpec = {
  title: string;
  /** The sidebar / tab accent, for pages that have a nav entry. */
  color?: string;
  // Each page takes its own props; App supplies them per page (`pageProps`).
  Component: ComponentType<any>;
};

export const PAGES: Record<BuiltinPage, PageSpec> = {
  home: { title: msg("Home"), color: "var(--coral)", Component: Home },
  dashboard: { title: msg("Explore"), color: "var(--purple)", Component: React.lazy(() => import("../dashboard/Dashboard")) },
  albums: { title: msg("Library"), color: "var(--blue)", Component: React.lazy(() => import("../albums/AlbumList")) },
  playlists: { title: msg("Playlists"), Component: React.lazy(() => import("../playlists/PlaylistView")) },
};

/** The pages the sidebar lists at the top, in order (plugins follow). */
export const SIDEBAR_PAGES: readonly BuiltinPage[] = ["home", "dashboard", "albums"];

export function isBuiltinPage(page: string): page is BuiltinPage {
  return (BUILTIN_PAGES as readonly string[]).includes(page);
}

/** The page's title key (untranslated), or undefined for an unknown page. */
export function pageTitle(page: Page): string | undefined {
  if (page === "settings") return msg("Settings");
  if (isBuiltinPage(page)) return PAGES[page].title;
  return pluginPages.find((p) => p.id === page)?.title;
}
