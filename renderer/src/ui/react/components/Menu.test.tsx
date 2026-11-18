import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Menu from "./Menu";

it("puts the status beside the label and the full-width detail on the next line", () => {
  render(<Menu open x={40} y={40} onClose={vi.fn()} items={[
    { label: "LRCLIB", hint: "● Synced", detail: "Album · 3:54 · 42 lines" },
  ]} />);
  const label = screen.getByText("LRCLIB");
  const status = screen.getByText("● Synced");
  const detail = screen.getByText("Album · 3:54 · 42 lines");
  expect(status.parentElement).toBe(label.parentElement);
  expect(label.parentElement).toHaveClass("flex", "items-baseline");
  expect(detail.parentElement).toHaveAttribute("data-detail");
  expect(detail.parentElement).toHaveClass("flex-col", "flex-1");
  expect(detail.previousElementSibling).toBe(label.parentElement);
  expect(screen.getByRole("menu")).toHaveClass("has-[[data-detail]]:max-w-[440px]");
});

function setup() {
  const onClose = vi.fn();
  render(<>
    <div data-testid="scroller" style={{ overflow: "auto", height: 20 }}>
      <div style={{ height: 200 }}>Background</div>
      <input aria-label="Background input" />
      <textarea aria-label="Background textarea" />
      <div contentEditable suppressContentEditableWarning>Editable</div>
    </div>
    <Menu open x={40} y={40} onClose={onClose} items={[
      { label: "Play" },
      { label: "Lists", submenu: [{ label: "Favorites" }] },
    ]} />
  </>);
  return { onClose, scroller: screen.getByTestId("scroller"), menu: screen.getByRole("menu") };
}

it("keeps the menu open when code scrolls a background container", () => {
  const { onClose, scroller } = setup();
  scroller.scrollTop = 100;
  // jsdom does not dispatch a scroll event for the scrollTop assignment.
  fireEvent.scroll(scroller);
  fireEvent.scroll(window);
  expect(onClose).not.toHaveBeenCalled();
});

it.each(["wheel", "touchMove"] as const)("closes on %s outside the menu", event => {
  const { onClose, scroller } = setup();
  fireEvent[event](scroller);
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps the menu and submenu open while scrolling inside either", () => {
  const { onClose, menu } = setup();
  fireEvent.wheel(menu);
  fireEvent.touchMove(menu);
  fireEvent.scroll(menu);
  fireEvent.keyDown(menu, { key: "End" });
  fireEvent.keyDown(menu, { key: "ArrowRight" });
  const sub = screen.getByRole("menu", { name: "Lists" });
  fireEvent.wheel(sub);
  fireEvent.touchMove(sub);
  fireEvent.scroll(sub);
  expect(onClose).not.toHaveBeenCalled();
});

it.each(["PageUp", "PageDown", "Home", "End", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])(
  "closes on the scroll key %j outside the menu", key => {
    const { onClose, scroller } = setup();
    fireEvent.keyDown(scroller, { key });
    expect(onClose).toHaveBeenCalledOnce();
  },
);

it("keeps editing keys and non-scroll keys outside the menu from dismissing it", () => {
  const { onClose, scroller } = setup();
  for (const input of [screen.getByRole("textbox", { name: "Background input" }), screen.getByRole("textbox", { name: "Background textarea" }), screen.getByText("Editable")]) {
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: " " });
  }
  fireEvent.keyDown(scroller, { key: "a" });
  fireEvent.scroll(scroller);
  expect(onClose).not.toHaveBeenCalled();
});

it.each(["resize", "blur"] as const)("still closes on window %s", event => {
  const { onClose } = setup();
  fireEvent[event](window);
  expect(onClose).toHaveBeenCalledOnce();
});
