import { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSortableList } from "./useSortableList";

function Harness({ onReorder, scrolling = false }: { onReorder: (from: number, to: number) => void; scrolling?: boolean }) {
  const [items, setItems] = useState(["A", "B", "C"]);
  const scroller = useRef<HTMLDivElement>(null);
  const sort = useSortableList({ count: items.length, rowGap: 7, liftedClass: "lifted", scrollerRef: scrolling ? scroller : undefined,
    onReorder: (from, to) => {
      onReorder(from, to);
      setItems(old => { const next = [...old]; next.splice(to, 0, ...next.splice(from, 1)); return next; });
    } });
  return <div ref={scroller} data-testid="scroller">
    <ul data-testid="list" data-settling={sort.settling ? "" : undefined}>
      {items.map((item, i) => <li key={item} ref={el => { if (el) sort.rows.current[i] = el; }} style={{ transform: sort.shiftOf(i) }}>
        <button {...sort.gripProps(i)}>{item}</button>
      </li>)}
    </ul>
    <div role="status">{sort.announce}</div>
  </div>;
}

function geometry() {
  for (const [i, row] of [...screen.getByTestId("list").children].entries()) {
    Object.defineProperties(row, { offsetTop: { configurable: true, value: i * 37 }, offsetHeight: { configurable: true, value: 30 } });
  }
}
function pointer(target: HTMLElement, type: string, y: number, pointerId = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(target, event);
}
function setup(scrolling = false) {
  const reorder = vi.fn();
  render(<Harness onReorder={reorder} scrolling={scrolling} />);
  geometry();
  const grip = screen.getByRole("button", { name: "A" });
  const capture = vi.fn();
  grip.setPointerCapture = capture;
  return { reorder, grip, capture };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useSortableList", () => {
  it("captures on the grip, paints the lifted row and shifts siblings, committing only once on release", () => {
    const { reorder, grip, capture } = setup();
    pointer(grip, "pointerdown", 15);
    expect(capture).toHaveBeenCalledWith(1);
    expect(grip.parentElement).toHaveClass("lifted");
    pointer(grip, "pointermove", 94, 2); // another pointer cannot affect this drag
    expect(grip.parentElement!.style.transform).toBe("");
    pointer(grip, "pointermove", 94);
    expect(grip.parentElement!.style.transform).toBe("translateY(79px)");
    expect(screen.getByRole("button", { name: "B" }).parentElement!.style.transform).toBe("translateY(-37px)");
    expect(screen.getByRole("button", { name: "C" }).parentElement!.style.transform).toBe("translateY(-37px)");
    expect(reorder).not.toHaveBeenCalled();
    pointer(grip, "pointerup", 94, 2);
    expect(reorder).not.toHaveBeenCalled();
    pointer(grip, "pointerup", 94);
    pointer(grip, "pointerup", 94);
    expect(reorder).toHaveBeenCalledExactlyOnceWith(0, 2);
    expect(screen.getAllByRole("button").map(el => el.textContent)).toEqual(["B", "C", "A"]);
    expect(grip.parentElement).not.toHaveClass("lifted");
    expect(grip.parentElement!.style.transform).toBe("");
    expect(screen.getByTestId("list")).toHaveAttribute("data-settling");
    expect(screen.getByRole("status")).toHaveTextContent("Movida a la posición 3 de 3");
  });

  it.each(["Escape", "pointercancel", "lostpointercapture"])("cancels on %s without changing order", action => {
    const { reorder, grip } = setup();
    pointer(grip, "pointerdown", 15);
    pointer(grip, "pointermove", 94);
    if (action === "Escape") fireEvent.keyDown(document.body, { key: "Escape" });
    else pointer(grip, action, 94);
    pointer(grip, "pointerup", 94);
    expect(reorder).not.toHaveBeenCalled();
    expect(grip.parentElement).not.toHaveClass("lifted");
    expect(grip.parentElement!.style.transform).toBe("");
  });

  it("moves by keyboard, announces, follows focus, and respects the endpoints", () => {
    const { reorder, grip } = setup();
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(reorder).not.toHaveBeenCalled();
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(reorder).toHaveBeenLastCalledWith(0, 1);
    expect(grip).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Movida a la posición 2 de 3");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(reorder).toHaveBeenLastCalledWith(1, 2);
    expect(grip).toHaveFocus();
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(reorder).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(reorder).toHaveBeenLastCalledWith(2, 1);
    expect(grip).toHaveFocus();
  });

  it("keeps queue edge auto-scroll and includes scroll distance in the lifted transform; cancellation stops it", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn(cb => { frames.push(cb); return frames.length; }));
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const { grip, reorder } = setup(true);
    const scroller = screen.getByTestId("scroller");
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 200 } as DOMRect);
    pointer(grip, "pointerdown", 15);
    pointer(grip, "pointermove", 200);
    act(() => frames[0](0));
    expect(scroller.scrollTop).toBe(14);
    expect(grip.parentElement!.style.transform).toBe("translateY(199px)");
    pointer(grip, "pointermove", 0);
    act(() => frames[1](0));
    expect(scroller.scrollTop).toBe(0);
    expect(grip.parentElement!.style.transform).toBe("translateY(-15px)");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(cancel).toHaveBeenCalledWith(3);
    expect(reorder).not.toHaveBeenCalled();
  });

  it("ignores non-primary presses and taps without a changed slot", () => {
    const { grip, capture, reorder } = setup();
    pointer(grip, "pointerdown", 15, 1, 2);
    expect(capture).not.toHaveBeenCalled();
    pointer(grip, "pointerdown", 15);
    pointer(grip, "pointerup", 15);
    expect(reorder).not.toHaveBeenCalled();
  });
});
