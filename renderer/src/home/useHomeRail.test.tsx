import { useLayoutEffect, useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setFakeBridgeForTest } from "../bridge";
import type { IpcEventPayload, KrobiBridge } from "../lib/ipc";
import { HOME_RAIL_FOLDED_KEY, toggleHomeRail, useHomeRailLayout, useHomeRailShortcut } from "./useHomeRail";
import css from "./home-rail.css?raw";
import tokens from "../ui/tokens/app.css?raw";

function Rail({ enabled = true, painted }: { enabled?: boolean; painted?: (folded: boolean) => void }) {
  const rootRef = useRef<HTMLElement>(null);
  const folded = useHomeRailLayout(rootRef, enabled);
  useHomeRailShortcut(enabled);
  useLayoutEffect(() => { painted?.(folded); }, [folded, painted]);
  return <div className="shell-frame"><main ref={rootRef} />
    <aside className="home-rail" data-folded={folded ? "" : undefined} inert={folded}>
      <div className="home-rail__clip">Content</div>
    </aside>
    <button onClick={toggleHomeRail} aria-expanded={!folded}>Toggle</button>
    <input aria-label="Typing" /><textarea aria-label="Notes" /><div contentEditable suppressContentEditableWarning role="textbox" aria-label="Editable"><span>Edit</span></div>
  </div>;
}
function stored(folded: boolean) {
  localStorage.setItem(HOME_RAIL_FOLDED_KEY, folded ? "1" : "0");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: HOME_RAIL_FOLDED_KEY })));
}
const shortcut = { metaKey: true, altKey: true, code: "Backslash", key: "«" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("restores the stored fold before the first layout effect and retains it across Home mounts", () => {
  localStorage.setItem(HOME_RAIL_FOLDED_KEY, "1");
  const painted = vi.fn();
  const view = render(<Rail painted={painted} />);
  expect(painted).toHaveBeenNthCalledWith(1, true);
  expect(view.container.querySelector("aside")).toHaveAttribute("data-folded");
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  expect(localStorage.getItem(HOME_RAIL_FOLDED_KEY)).toBe("0");
  view.unmount();
  render(<Rail painted={painted} />);
  expect(painted).toHaveBeenLastCalledWith(false);
});

it("auto-folds below 640px of main space without writing storage and restores either choice on widening", () => {
  let width = 1200;
  let resize: ResizeObserverCallback;
  const observe = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width }) as DOMRect);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = observe;
    disconnect = vi.fn();
  });
  const view = render(<Rail />);
  stored(false);
  const write = vi.spyOn(Storage.prototype, "setItem");
  expect(observe).toHaveBeenCalledWith(view.container.querySelector(".shell-frame"));
  const rail = view.container.querySelector("aside")!;
  width = 959;
  act(() => resize([], {} as ResizeObserver));
  expect(rail).toHaveAttribute("data-folded");
  expect(rail).toHaveAttribute("data-resizing");
  expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  width = 960;
  act(() => resize([], {} as ResizeObserver));
  expect(rail).not.toHaveAttribute("data-folded");
  expect(write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  write.mockClear();
  width = 800;
  act(() => resize([], {} as ResizeObserver));
  width = 1200;
  act(() => resize([], {} as ResizeObserver));
  expect(rail).toHaveAttribute("data-folded");
  expect(write).not.toHaveBeenCalled();
  expect(localStorage.getItem(HOME_RAIL_FOLDED_KEY)).toBe("1");
});

it("Option-Command-backslash shares the toggle state, ignores typing, repeats, and plain Command-backslash", () => {
  const view = render(<Rail />);
  stored(false);
  const button = screen.getByRole("button");
  fireEvent.keyDown(window, shortcut);
  expect(button).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(window, { ...shortcut, altKey: false, key: "\\" });
  fireEvent.keyDown(window, { ...shortcut, repeat: true });
  for (const target of [screen.getByRole("textbox", { name: "Typing" }), screen.getByRole("textbox", { name: "Notes" }), screen.getByText("Edit")]) {
    fireEvent.keyDown(target, shortcut);
  }
  expect(button).toHaveAttribute("aria-expanded", "true");
  view.rerender(<Rail enabled={false} />);
  fireEvent.keyDown(window, shortcut);
  expect(button).toHaveAttribute("aria-expanded", "true");
});

it("keeps the folded end state under reduced motion, with no transition or delayed content", () => {
  const view = render(<Rail />);
  stored(false);
  fireEvent.click(screen.getByRole("button"));
  expect(view.container.querySelector("aside")).toHaveAttribute("data-folded");
  expect(css).toContain("transition: width var(--dur-sidebar) var(--ease-spring)");
  expect(css).toContain("opacity var(--dur-fast) var(--ease-out) calc(var(--dur-sidebar) / 3)");
  expect(css).toMatch(/data-folded\] .home-rail__clip \{ opacity: 0;[^}]*transition-delay: 0s/);
  expect(css).toMatch(/prefers-reduced-motion: reduce[^}]*\.home-rail, .home-rail .home-rail__clip \{ transition: none !important/s);
  expect(tokens).toMatch(/prefers-reduced-motion: reduce[^}]*--dur-sidebar: 0ms/s);
});

it("a native view command toggles the Home column once per press, ignores other commands, and unsubscribes off Home or in portrait", () => {
  const listeners = new Set<(command: IpcEventPayload<'view:command'>) => void>();
  const fake: KrobiBridge = {
    invoke: vi.fn(),
    on: ((channel: string, listener: (command: IpcEventPayload<'view:command'>) => void) => {
      expect(channel).toBe("view:command");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }) as KrobiBridge['on'],
  };
  const restore = setFakeBridgeForTest(fake);
  const emit = (command: IpcEventPayload<'view:command'>) => act(() => listeners.forEach(listener => listener(command)));
  try {
    const view = render(<Rail />);
    stored(false);
    const button = screen.getByRole("button");
    expect(listeners.size).toBe(1);
    emit("toggle-sidebar");
    // A native accelerator and even a forwarded webview keydown are one toggle.
    fireEvent.keyDown(window, shortcut);
    expect(button).toHaveAttribute("aria-expanded", "true");
    emit("toggle-side-column");
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(window, shortcut);
    expect(button).toHaveAttribute("aria-expanded", "false");
    emit("toggle-side-column");
    expect(button).toHaveAttribute("aria-expanded", "true");
    const lateCommand = [...listeners][0];
    // Header supplies false for off Home, browse overlays, and portrait layouts.
    view.rerender(<Rail enabled={false} />);
    expect(listeners.size).toBe(0);
    emit("toggle-side-column");
    act(() => lateCommand("toggle-side-column"));
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem(HOME_RAIL_FOLDED_KEY)).toBe("0");
    view.rerender(<Rail />);
    expect(listeners.size).toBe(1);
    view.unmount();
    expect(listeners.size).toBe(0);
  } finally { restore(); }
});
