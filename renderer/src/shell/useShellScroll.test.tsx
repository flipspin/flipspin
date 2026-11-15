import { useRef } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SHELL_SCROLL_THRESHOLD_PX, useShellScroll } from "./useShellScroll";
import { useFloatingHeaderLayout } from "./useFloatingHeaderLayout";
import topbarCss from "./layout/topbar.css?raw";

let renders = 0;
let frames: Map<number, FrameRequestCallback>;
let sequence = 0;
function Shell({ page = "home", floating = true, restored = 0 }: { page?: string; floating?: boolean; restored?: number }) {
  renders++;
  const header = useRef<HTMLElement>(null);
  const layout = useFloatingHeaderLayout(page, page.startsWith("browse-") ? page.slice(7) : undefined);
  useShellScroll(header, page, floating && layout);
  return <div className="shell-frame">
    <header ref={header} className="app-header" data-floating={floating && layout ? "" : undefined}><div className="app-header__title"><button>Play</button></div></header>
    <main className="k-page">
      <div key={page} className={page === "home" ? "home-main" : page === "albums" ? "library-scroll" : "browse-slot"}
        ref={element => { if (element) element.scrollTop = restored; }} style={{ overflowY: "auto" }}>
        <div style={{ overflowX: "auto" }}>Carousel</div>
      </div>
    </main>
  </div>;
}
function flush() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
}
beforeEach(() => {
  frames = new Map();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["home", "dashboard", "browse-album", "browse-artist", "browse-playlist", "browse-search"])("reveals %s only past 200px, coalesces captured scrolls and hides again without rendering", page => {
  const view = render(<Shell page={page} />);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  const count = renders;
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  expect(bar.firstElementChild).not.toHaveAttribute("aria-hidden");
  expect(bar.firstElementChild).not.toHaveAttribute("inert");
  scroller.scrollTop = SHELL_SCROLL_THRESHOLD_PX;
  fireEvent.scroll(scroller, { bubbles: false });
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  scroller.scrollTop++;
  fireEvent.scroll(scroller, { bubbles: false });
  fireEvent.scroll(scroller, { bubbles: false });
  expect(frames.size).toBe(1);
  flush();
  expect(bar).toHaveAttribute("data-scrolled");
  expect(bar.firstElementChild).not.toHaveAttribute("aria-hidden");
  expect(bar.firstElementChild).not.toHaveAttribute("inert");
  fireEvent.scroll(scroller.firstElementChild!); // Horizontal rows don't change the page state.
  flush();
  expect(bar).toHaveAttribute("data-scrolled");
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller, { bubbles: false });
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  expect(renders).toBe(count);
});

it("launches hidden, ignores stale early geometry/events and reads the real offset in the scheduled frame", () => {
  const observer = vi.fn();
  vi.stubGlobal("IntersectionObserver", observer);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: -500, bottom: -400 } as DOMRect);
  const view = render(<Shell />);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  expect(bar).not.toHaveAttribute("data-scrolled");
  scroller.scrollTop = 500;
  fireEvent.scroll(scroller);
  scroller.scrollTop = 0; // Layout settles before the queued scroll check.
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  expect(observer).not.toHaveBeenCalled();
});

it("cancels old frames and resets on page/route change, including browse-to-browse", () => {
  const view = render(<Shell />);
  const bar = view.container.querySelector("header")!;
  for (const page of ["dashboard", "browse-album", "browse-artist"]) {
    const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);
    flush();
    expect(bar).toHaveAttribute("data-scrolled");
    fireEvent.scroll(scroller); // Pending old-route work must be cancelled.
    view.rerender(<Shell page={page} />);
    expect(bar).not.toHaveAttribute("data-scrolled");
    fireEvent.scroll(scroller); // Detached old route.
    flush();
    expect(bar).not.toHaveAttribute("data-scrolled");
  }
});

it.each(["albums", "playlists", "plugin-page"])("keeps %s solid and accessible without scheduling inner scroll checks", page => {
  const view = render(<Shell page={page} />);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  expect(bar).not.toHaveAttribute("data-floating");
  expect(bar.firstElementChild).not.toHaveAttribute("aria-hidden");
  expect(bar.firstElementChild).not.toHaveAttribute("inert");
  expect(frames.size).toBe(0);
  for (const offset of [0, 200, 500, 0]) {
    scroller.scrollTop = offset;
    fireEvent.scroll(scroller, { bubbles: false });
    expect(frames.size).toBe(0);
    expect(bar).not.toHaveAttribute("data-scrolled");
  }
});

it("clears a scrolled Home on Library and returns to Home transparent at the top", () => {
  const view = render(<Shell />);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  scroller.scrollTop = 500;
  fireEvent.scroll(scroller);
  flush();
  expect(bar).toHaveAttribute("data-scrolled");
  fireEvent.scroll(scroller); // Cancel work queued before leaving Home.
  view.rerender(<Shell page="albums" />);
  expect(bar).not.toHaveAttribute("data-floating");
  expect(bar).not.toHaveAttribute("data-scrolled");
  expect(bar.firstElementChild).not.toHaveAttribute("aria-hidden");
  expect(bar.firstElementChild).not.toHaveAttribute("inert");
  expect(frames.size).toBe(0);
  expect(view.container.querySelector<HTMLElement>(".shell-frame")!.style.getPropertyValue("--topbar-height")).toBe("");
  view.rerender(<Shell />);
  expect(bar).toHaveAttribute("data-floating");
  expect(bar).not.toHaveAttribute("data-scrolled");
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  expect(bar.firstElementChild).not.toHaveAttribute("inert");
});

it("rechecks real restored positions on mount, fonts.ready, visibility, resize and async mounts", async () => {
  let fontsReady: (() => void) | undefined;
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>(resolve => { fontsReady = resolve; }) } });
  const view = render(<Shell restored={350} />);
  const bar = view.container.querySelector("header")!;
  const shell = view.container.querySelector<HTMLElement>(".shell-frame")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  expect(bar).not.toHaveAttribute("data-scrolled");
  flush();
  expect(bar).toHaveAttribute("data-scrolled");
  scroller.scrollTop = 0;
  await act(async () => { fontsReady?.(); });
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  scroller.scrollTop = 350;
  fireEvent(document, new Event("visibilitychange"));
  flush();
  expect(bar).toHaveAttribute("data-scrolled");
  scroller.scrollTop = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 92 } as DOMRect);
  fireEvent.resize(window);
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  expect(shell.style.getPropertyValue("--topbar-height")).toBe("92px");
  scroller.scrollTop = 350;
  await act(async () => { scroller.append(document.createElement("div")); });
  flush();
  expect(bar).toHaveAttribute("data-scrolled");
  view.unmount();
  expect(frames.size).toBe(0);
  expect(shell.style.getPropertyValue("--topbar-height")).toBe("");
  Reflect.deleteProperty(document, "fonts");
});

it("ignores retained hidden pages and keeps the portrait title accessible even when scrolled", () => {
  const view = render(<Shell floating={false} />);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  scroller.scrollTop = 350;
  fireEvent.scroll(scroller);
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  expect(bar.firstElementChild).not.toHaveAttribute("aria-hidden");
  expect(bar.firstElementChild).not.toHaveAttribute("inert");
  view.rerender(<Shell />);
  scroller.classList.add("hidden");
  fireEvent.scroll(scroller);
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
});

it("puts shared clearance on page scrollers, uses centred 28px titles and preserves reduced motion", () => {
  expect(topbarCss).toContain("--shell-content-top: calc(var(--topbar-height) + var(--shell-content-gap))");
  expect(topbarCss).toMatch(/\.shell-page > :not\(\.home-floating\),[\s\S]*?\.browse-slot \{ padding-top: var\(--shell-content-top\)/);
  expect(topbarCss).not.toContain(".library-scroll");
  expect(topbarCss).not.toContain('[data-page="albums"]');
  expect(topbarCss).not.toContain(".playlist-header-strip");
  expect(topbarCss).toContain('.shell-page[data-page="dashboard"] > * { overflow-y: auto;');
  expect(topbarCss).toContain('.shell-page[data-page="dashboard"] .explore-columns { flex: none; }');
  expect(topbarCss).toContain('.shell-page[data-page="dashboard"] .explore-column { overflow-y: visible; }');
  expect(topbarCss).toContain("align-items: center");
  expect(topbarCss).toMatch(/prefers-reduced-motion: reduce[\s\S]*transition: none/);
});

it("turns the ground solid as soon as content passes under the bar, before the title", () => {
  const view = render(<Shell page="home" />);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  flush();
  expect(bar).not.toHaveAttribute("data-covered");
  scroller.scrollTop = 12;
  fireEvent.scroll(scroller, { bubbles: false });
  flush();
  expect(bar).toHaveAttribute("data-covered");
  expect(bar).not.toHaveAttribute("data-scrolled");
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller, { bubbles: false });
  flush();
  expect(bar).not.toHaveAttribute("data-covered");
});

it("reveals halfway through a page that can't scroll 200px (Home in full screen)", () => {
  const view = render(<Shell page="home" />);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1150 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 1000 });
  flush();
  scroller.scrollTop = 75;
  fireEvent.scroll(scroller, { bubbles: false });
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  scroller.scrollTop = 76;
  fireEvent.scroll(scroller, { bubbles: false });
  flush();
  expect(bar).toHaveAttribute("data-scrolled");
});

it("draws no rule under the scrolled bar and makes its ground solid on data-covered", () => {
  expect(topbarCss).toMatch(/\.app-header\[data-covered\]::before\s*\{\s*opacity:\s*1/);
  expect(topbarCss).not.toMatch(/border-bottom:\s*2px solid var\(--line\)/);
});

it("hands a page's own title row to the bar as soon as the ground turns solid (Explore)", () => {
  const view = render(<Shell page="dashboard" />);
  const bar = view.container.querySelector("header")!;
  const scroller = view.container.querySelector<HTMLElement>(".k-page > div")!;
  const head = document.createElement("header");
  head.innerHTML = "<h1>Explore</h1>";
  scroller.prepend(head);
  flush();
  expect(bar).not.toHaveAttribute("data-scrolled");
  scroller.scrollTop = 3;
  fireEvent.scroll(scroller, { bubbles: false });
  flush();
  expect(bar).toHaveAttribute("data-covered");
  expect(bar).toHaveAttribute("data-scrolled");
});
