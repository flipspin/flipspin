import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => ({ play: vi.fn() }) }));
vi.mock("@state/SettingsContext", () => ({ useSettings: () => ({ mode: "light", setMode: vi.fn() }) }));
vi.mock("../ServerBadge", () => ({ openSettings: vi.fn(), useNestStatus: () => ({ label: "Nido", color: "green", hint: "" }) }));
vi.mock("../../attention/useAttention", () => ({ useAttention: () => ({ data: null, refetch: vi.fn(), isFetching: false }) }));

vi.mock("@state/LibraryContext", () => ({ useLibrary: () => ({ baseDir: "" }) }));
vi.mock("../../data", () => ({ useCurrentUser: () => ({ data: { label: "Nico", role: "member" } }) }));
vi.mock("../../downloads/DownloadsMenu", () => ({ default: () => null }));
import Header, { AccountBlock, ModeMenu } from "./header";
import { HOME_RAIL_FOLDED_KEY } from "../../home/useHomeRail";
import { setFakeBridgeForTest } from "../../bridge";
import type { IpcEventPayload, KrobiBridge } from "../../lib/ipc";
import { setHeaderTitle } from "../headerTitle";
import { push, reset } from "../../browse/navigationStore";
import css from "../../styles/retro-song-table.css?raw";
import topbarCss from "./topbar.css?raw";
afterEach(() => {
  act(() => { setHeaderTitle(null); reset(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["home", "dashboard"])("floats %s with its title always shown and keeps the controls and drag region", activePage => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  try {
    const view = render(<Header activePage={activePage} />);
    expect(screen.getByRole("heading")).toBeTruthy();
    expect(view.container.querySelector(".app-header__title")).not.toHaveAttribute("inert");
    expect(view.container.querySelector("header")).toHaveAttribute("data-floating");
    expect(view.container.querySelector("header")).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(screen.getByRole("button", { name: /Apariencia/ })).toHaveClass("topbar-control");
  } finally { vi.unstubAllGlobals(); }
});

it.each(["album", "artist", "playlist", "search"])("floats the catalog %s route opened over Explore", kind => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const view = render(<Header activePage="dashboard" />);
  act(() => push({ kind, id: "catalog-item", title: "Catalog item" }));
  expect(view.container.querySelector("header")).toHaveAttribute("data-floating");
  expect(view.container.querySelector(".app-header__title")).not.toHaveAttribute("inert");
  expect(screen.getByRole("heading")).toBeTruthy();
});

it.each([
  ["albums", "Biblioteca"], ["playlists", "Playlists"], ["plugin-page", "Plugin page"],
])("keeps %s solid with its title at zero and after inner scrolling", (activePage, title) => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  if (activePage === "plugin-page") act(() => setHeaderTitle(title));
  const view = render(<div className="shell-frame"><Header activePage={activePage} />
    <main className="k-page"><div className="inner-scroll" style={{ overflowY: "auto" }} /></main>
  </div>);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".inner-scroll")!;
  expect(bar).not.toHaveAttribute("data-floating");
  expect(bar).toHaveStyle({ background: "var(--panel)" });
  expect(screen.getByRole("heading", { name: title })).toHaveStyle({ fontSize: "22px" });
  for (const offset of [0, 201, 500, 0]) {
    scroller.scrollTop = offset;
    fireEvent.scroll(scroller, { bubbles: false });
    expect(bar).not.toHaveAttribute("data-scrolled");
    expect(screen.getByRole("heading", { name: title })).toBeVisible();
    expect(view.container.querySelector(".app-header__title")).not.toHaveAttribute("inert");
  }
});

it("keeps Library's song and album counts beside its solid title", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const albums = ["Workshop", "Studio"].map((album, index) => ({
    album, artist: "Artist", path: album, compilation: false,
    tracks: Array.from({ length: index === 0 ? 2 : 1 }, (_, track) => ({
      title: `Track ${track}`, artist: "Artist", path: `${album}/${track}.flac`, url_path: "", missingFromNest: false,
      bpmEstimated: false, keyEstimated: false, analysisState: "none" as const, bpmFixed: false, keyFixed: false,
    })),
  }));
  render(<Header activePage="albums" albums={albums} />);
  expect(screen.getByRole("heading", { name: "Biblioteca" })).toBeVisible();
  expect(screen.getByText("3 canciones · 2 álbumes")).toBeVisible();
});

it.each(["library-album", "library-artist", "library-search"])("keeps the %s route solid even over Home", kind => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const view = render(<Header />);
  act(() => push({ kind, id: "library-item", title: "Library item" }));
  expect(view.container.querySelector("header")).not.toHaveAttribute("data-floating");
  expect(screen.getByRole("heading")).toBeVisible();
});

it("keeps narrow and portrait pages solid with their title", () => {
  const view = render(<Header activePage="playlists" />);
  expect(screen.getByRole("heading", { name: "Playlists" })).toBeTruthy();
  expect(view.container.querySelector("header")).not.toHaveAttribute("data-floating");
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  try {
    view.rerender(<Header portrait />);
    expect(screen.getByRole("heading", { name: "Inicio" })).toBeTruthy();
    expect(view.container.querySelector("header")).not.toHaveAttribute("data-floating");
  } finally { vi.unstubAllGlobals(); }
});

it("fades only the bar's ground, on motion tokens, and never hides the title", () => {
  expect(topbarCss).toContain("opacity var(--dur-fast) var(--ease-out)");
  expect(topbarCss).not.toMatch(/\.app-header__title\s*\{[^}]*opacity:\s*0/);
  expect(topbarCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*::before \{ transition: none/);
  expect(topbarCss).toMatch(/data-page="dashboard"\] > \* > header:first-child h1 \{ display: none; \}/);
});

describe("header dropdowns", () => {
  it("the appearance menu opens on the popover, Escape closes it, focus returns", async () => {
    const user = userEvent.setup();
    render(<ModeMenu />);
    const trigger = screen.getByRole("button", { name: /Apariencia/ });
    await user.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("k-popover");
    expect(menu.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("the account menu does the same", async () => {
    const user = userEvent.setup();
    render(<AccountBlock name="Nico" account={{ role: "member" }} />);
    const trigger = screen.getByRole("button", { name: /Nico/ });
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Nico" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

it("keeps Playlists at rest and fades in the mini cover, name and list-colour play key", () => {
  const play = vi.fn();
  const strip = { name: "Workshop", coverUrl: "/mini-cover.jpg", color: "var(--teal)", ink: "var(--ink)", play, collapsed: false };
  act(() => setHeaderTitle(strip));
  const { container } = render(<Header activePage="playlists" openPlaylist="Workshop" onMenuClick={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Playlists" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reproducir Workshop" })).toBeNull();
  act(() => setHeaderTitle({ ...strip, collapsed: true }));
  expect(screen.queryByRole("heading", { name: "Playlists" })).toBeNull();
  const button = screen.getByRole("button", { name: "Reproducir Workshop" });
  expect(button.style.background).toBe("var(--teal)");
  expect(container.querySelector(".playlist-header-strip img")?.getAttribute("src")).toBe("/mini-cover.jpg");
  fireEvent.click(button);
  expect(play).toHaveBeenCalledOnce();
  expect(css).toContain("transition: opacity var(--dur-fast) var(--ease-out)");
  act(() => setHeaderTitle(strip));
  expect(screen.getByRole("heading", { name: "Playlists" })).toBeTruthy();
});

it("shows one fixed toggle only for landscape Home, with its shortcut and expanded state", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.setItem(HOME_RAIL_FOLDED_KEY, "0");
  const view = render(<Header />);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: HOME_RAIL_FOLDED_KEY })));
  const toggle = screen.getByRole("button", { name: "Ocultar la columna lateral" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle).toHaveAttribute("title", "Ocultar la columna lateral · ⌥⌘\\");
  expect(toggle.nextElementSibling?.querySelector(".app-account__trigger")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveAttribute("title", "Mostrar la columna lateral · ⌥⌘\\");
  view.rerender(<Header activePage="albums" />);
  expect(screen.queryByRole("button", { name: /columna lateral/ })).toBeNull();
  view.rerender(<Header portrait />);
  expect(screen.queryByRole("button", { name: /columna lateral/ })).toBeNull();
  vi.unstubAllGlobals();
});

it("accepts the native side-column command only on landscape Home, preserving the preference elsewhere", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const listeners = new Set<(command: IpcEventPayload<'view:command'>) => void>();
  const fake: KrobiBridge = {
    invoke: vi.fn().mockResolvedValue({ forced: false }),
    on: ((channel: string, listener: (command: IpcEventPayload<'view:command'>) => void) => {
      if (channel !== "view:command") return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }) as KrobiBridge['on'],
  };
  const restore = setFakeBridgeForTest(fake);
  const emit = () => act(() => listeners.forEach(listener => listener("toggle-side-column")));
  try {
    localStorage.setItem(HOME_RAIL_FOLDED_KEY, "0");
    const view = render(<Header />);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: HOME_RAIL_FOLDED_KEY })));
    expect(listeners.size).toBe(1);
    emit();
    expect(screen.getByRole("button", { name: "Mostrar la columna lateral" })).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem(HOME_RAIL_FOLDED_KEY)).toBe("1");
    for (const props of [{ activePage: "albums" }, { portrait: true }]) {
      view.rerender(<Header {...props} />);
      expect(listeners.size).toBe(0);
      emit();
      expect(localStorage.getItem(HOME_RAIL_FOLDED_KEY)).toBe("1");
    }
    view.rerender(<Header />);
    emit();
    expect(screen.getByRole("button", { name: "Ocultar la columna lateral" })).toHaveAttribute("aria-expanded", "true");
    view.unmount();
    expect(listeners.size).toBe(0);
  } finally { restore(); vi.unstubAllGlobals(); }
});

it("lets PlaylistView's collapse state alone show its original cover/name/play strip in landscape", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const play = vi.fn();
  const strip = { name: "Workshop", coverUrl: "/mini-cover.jpg", color: "var(--teal)", ink: "var(--ink)", play, collapsed: false };
  act(() => setHeaderTitle(strip));
  try {
    const view = render(<div className="shell-frame"><Header activePage="playlists" openPlaylist="Workshop" />
      <main className="k-page"><div className="playlist-page" style={{ overflowY: "auto" }} /></main>
    </div>);
    const scroller = view.container.querySelector<HTMLElement>(".playlist-page")!;
    const bar = view.container.querySelector("header")!;
    expect(bar).not.toHaveAttribute("data-floating");
    expect(bar).not.toHaveAttribute("data-scrolled");
    expect(screen.getByRole("heading", { name: "Playlists" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reproducir Workshop" })).toBeNull();
    scroller.scrollTop = 201;
    fireEvent.scroll(scroller);
    expect(bar).not.toHaveAttribute("data-scrolled");
    expect(screen.queryByRole("button", { name: "Reproducir Workshop" })).toBeNull();
    // PlaylistView owns this state through its own sentinel observer.
    act(() => setHeaderTitle({ ...strip, collapsed: true }));
    const button = screen.getByRole("button", { name: "Reproducir Workshop" });
    fireEvent.click(button);
    expect(play).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".playlist-header-strip img")).toHaveAttribute("src", "/mini-cover.jpg");
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(bar).not.toHaveAttribute("data-scrolled");
    expect(screen.getByRole("button", { name: "Reproducir Workshop" })).toBeVisible();
    act(() => setHeaderTitle(strip));
    expect(screen.queryByRole("button", { name: "Reproducir Workshop" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Playlists" })).toBeVisible();
    expect(css).toContain("font: 700 16px var(--font-display, system-ui, sans-serif)");
    expect(topbarCss).not.toContain(".playlist-header-strip");
  } finally { vi.unstubAllGlobals(); }
});
