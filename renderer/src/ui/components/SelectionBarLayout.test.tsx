import { render } from "../../library/tracks/songMenuTestSupport";
import { useRef } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SelectionBar from "./SelectionBar";
import SelectionBarLayout from "./SelectionBarLayout";
import css from "./selection-bar.css?raw";

vi.mock("../../offline/useOffline", () => ({ useOffline: () => false }));
vi.mock("@state/identityStore", () => ({ useIdentity: () => ({}), isRealUser: () => false, subscribe: () => () => {}, getState: () => ({}) }));
vi.mock("@state/userLibraryStore", () => ({ relPathOf: () => null }));
vi.mock("../../acquisition/libraryActions", () => ({ pinTracks: vi.fn() }));
vi.mock("../../acquisition/removeActions", () => ({ useRemoveActions: () => [] }));
vi.mock("../../acquisition/offline", () => ({ useOffline: () => ({}), isDownloaded: () => false }));
vi.mock("../../lyrics/useLyricsMenu", () => ({ useLyricsMenu: () => [] }));

let resize: () => void;
let height: number;
let style: HTMLStyleElement;
beforeEach(() => {
  height = 48;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return { height: this.classList.contains("selection-bar") ? height : 0 } as DOMRect;
  });
  style = document.createElement("style");
  style.textContent = css.slice(css.indexOf(".selection-bar-layout {"), css.indexOf("@keyframes selection-bar-in"));
  document.head.append(style);
});
afterEach(() => { style.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Page({ library = false, count = 2, long = false }: { library?: boolean; count?: number; long?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bar = <SelectionBar count={count} tracks={[]} onPlay={vi.fn()} onPlayNext={vi.fn()} onQueue={vi.fn()}
    onClear={vi.fn()} playlistItems={[]} scrollRef={library ? scrollRef : undefined} />;
  return <SelectionBarLayout>
    <div ref={scrollRef} data-testid="scroll" style={{ overflowY: "auto", paddingBottom: 20 }}>
      <div style={{ height: long ? 3000 : 120 }}>Songs and covers</div>
      {!library && bar}
    </div>
    {library && bar}
  </SelectionBarLayout>;
}

it.each([
  ["landscape", false], ["landscape", true], ["portrait", false], ["portrait", true],
] as const)("anchors outside short/long page content in %s (long=%s)", (shell, long) => {
  document.documentElement.dataset.orientation = shell;
  const { rerender } = render(<Page long={long} />);
  const bar = screen.getByRole("toolbar");
  const dock = bar.parentElement!;
  expect(dock).toHaveClass("selection-bar-dock");
  expect(getComputedStyle(dock).position).toBe("absolute");
  expect(getComputedStyle(dock).bottom).toBe("16px");
  expect(getComputedStyle(dock.parentElement!).position).toBe("relative");
  const scroller = screen.getByTestId("scroll");
  expect(scroller).not.toContainElement(bar);
  expect(scroller.style.paddingBottom).toBe("100px");
  scroller.scrollTop = long ? 2400 : 0;
  expect(bar.parentElement).toBe(dock);
  height = 96; // Wrapped controls in portrait or a longer translation.
  act(() => resize());
  expect(scroller.style.paddingBottom).toBe("148px");
  rerender(<Page long={long} count={0} />);
  expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  expect(scroller.style.paddingBottom).toBe("20px");
  delete document.documentElement.dataset.orientation;
});

it("pads Library's sibling scroller and restores it on unmount", () => {
  const { unmount } = render(<Page library />);
  const scroller = screen.getByTestId("scroll");
  expect(scroller.style.paddingBottom).toBe("100px");
  expect(scroller).not.toContainElement(screen.getByRole("toolbar"));
  unmount();
  expect(scroller.style.paddingBottom).toBe("20px");
});

it("keeps a background library's dock inside its hidden branch", () => {
  const { container } = render(<><div hidden><Page library /></div><Page /></>);
  expect(screen.getAllByRole("toolbar")).toHaveLength(1);
  expect(container.querySelectorAll(".selection-bar-dock .selection-bar")).toHaveLength(2);

});
