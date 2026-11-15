import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryScrollStack } from "./LibraryFiltersStack";
import { savedScrollTop, usePersistedScroll } from "./hooks/usePersistedScroll";
import css from "./LibraryFilters.css?raw";
import panelSource from "./AlbumListPanel.tsx?raw";

let stackHeight: number;
let notifyIntersection: IntersectionObserverCallback;
let notifyResize: ResizeObserverCallback;
const disconnectIntersection = vi.fn();
const disconnectResize = vi.fn();
let observedRoot: Element | Document | null | undefined;
let observedTarget: Element;
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON() {} }) as DOMRect;

function Harness({ filterKey = "none", layout = "list" }: { filterKey?: string; layout?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const rowsStartRef = useRef<HTMLDivElement>(null);
  const onScroll = usePersistedScroll(scrollRef);
  const metrics = useLibraryScrollStack({ scrollRef, toolbarRef, stackRef, sentinelRef, rowsStartRef, filterKey, layout });
  return <div data-testid="scroll" ref={scrollRef} onScroll={onScroll}>
    <div ref={toolbarRef} data-testid="toolbar" />
    <div ref={sentinelRef} data-testid="sentinel" />
    <div ref={stackRef} data-testid="stack" />
    <div ref={rowsStartRef} data-testid="rows" />
    <output>{metrics.scrollMargin}/{metrics.stackHeight}</output>
  </div>;
}

beforeEach(() => {
  stackHeight = 36;
  disconnectIntersection.mockClear(); disconnectResize.mockClear();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { notifyIntersection = callback; observedRoot = options.root; }
    observe(target: Element) { observedTarget = target; }
    disconnect = disconnectIntersection;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { notifyResize = callback; }
    observe() {}
    disconnect = disconnectResize;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.closest<HTMLElement>('[data-testid="scroll"]')?.scrollTop || 0;
    switch (this.dataset.testid) {
      case "scroll": return rect(100, 500);
      case "toolbar": return rect(100 - top, 60);
      case "sentinel": return rect(160 - top, 1);
      case "stack": return rect(Math.max(100, 160 - top), stackHeight);
      case "rows": return rect(160 + stackHeight - top, 2000);
      default: return rect(0, 0);
    }
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2096);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
});
afterEach(() => {
  const scroller = screen.queryByTestId("scroll");
  if (scroller) { scroller.scrollTop = 0; fireEvent.scroll(scroller); }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function intersection(top: number, isIntersecting: boolean) {
  act(() => notifyIntersection([{ boundingClientRect: rect(top, 1), rootBounds: rect(100, 500), isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
}

describe("Library sticky stack", () => {
  it("observes the sentinel against the one scroller, toggling the shadow only above its top", () => {
    const view = render(<Harness />);
    const scroller = screen.getByTestId("scroll");
    expect(observedRoot).toBe(scroller);
    expect(observedTarget).toBe(screen.getByTestId("sentinel"));
    expect(scroller).toHaveAttribute("data-stuck", "false");
    expect(screen.getByText("96/36")).toBeInTheDocument();
    expect(scroller.style.getPropertyValue("--stack-h")).toBe("36px");
    intersection(99, false);
    expect(scroller).toHaveAttribute("data-stuck", "true");
    intersection(601, false); // Below the viewport is not stuck.
    expect(scroller).toHaveAttribute("data-stuck", "false");
    intersection(160, true);
    expect(scroller).toHaveAttribute("data-stuck", "false");
    view.unmount();
    expect(disconnectIntersection).toHaveBeenCalled();
    expect(disconnectResize).toHaveBeenCalled();
  });

  it("remeasures on resize and resets to result 1 when filters change while stuck", () => {
    const view = render(<Harness />);
    const scroller = screen.getByTestId("scroll");
    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);
    intersection(-740, false);
    stackHeight = 72;
    view.rerender(<Harness filterKey="bpm" />);
    expect(scroller.scrollTop).toBe(60);
    expect(screen.getByText("132/72")).toBeInTheDocument();
    expect(scroller.style.getPropertyValue("--stack-h")).toBe("72px");
    scroller.scrollTop = 100;
    stackHeight = 108;
    act(() => notifyResize([], {} as ResizeObserver));
    expect(screen.getByText("168/108")).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(100);
    intersection(60, false);
    stackHeight = 36;
    view.rerender(<Harness filterKey="none" />);
    expect(scroller.scrollTop).toBe(60);
    expect(screen.getByText("96/36")).toBeInTheDocument();
  });

  it("leaves the toolbar visible when changing a filter at rest", () => {
    const view = render(<Harness />);
    const scroller = screen.getByTestId("scroll");
    stackHeight = 72;
    view.rerender(<Harness filterKey="lyric" />);
    expect(scroller.scrollTop).toBe(0);
    expect(scroller).toHaveAttribute("data-stuck", "false");
  });

  it("restores the page offset on revisit and derives stuck before the observer fires", () => {
    const first = render(<Harness />);
    const scroller = screen.getByTestId("scroll");
    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);
    expect(savedScrollTop()).toBe(900);
    first.unmount();
    render(<Harness />);
    expect(screen.getByTestId("scroll").scrollTop).toBe(900);
    expect(screen.getByTestId("scroll")).toHaveAttribute("data-stuck", "true");
    expect(screen.getByText("96/36")).toBeInTheDocument();
  });

  it("keeps the pin, pre-drawn opacity shadow and group offset scoped to Library", () => {
    expect(css).toMatch(/\.library-sticky-stack\s*\{[^}]*position: sticky;[^}]*top: 0;/);
    expect(css).toMatch(/\.library-sticky-stack::after\s*\{[^}]*opacity: 0;[^}]*transition: opacity var\(--dur-fast\) var\(--ease\)/);
    expect(css).toContain('.library-scroll[data-stuck="true"] .library-sticky-stack::after { opacity: 1; }');
    expect(css).toContain('.library-table .retro-song-table__group { top: var(--stack-h, 0px); }');
    expect(css).toContain('scroll-padding-top: var(--stack-h, 0px)');
    expect(css).toContain('overflow-anchor: none');
    expect(panelSource).toContain('scrollMargin={scrollMargin}');
    expect(panelSource).toContain('scrollPaddingStart={stackHeight}');
    expect(panelSource).not.toContain('--song-gutter');
  });
});
