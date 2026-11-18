import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModalLayer } from "./ModalLayer";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Popover } from "./Popover";

function Harness({ initialFocus }: { initialFocus?: "first" | "container" | "none" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button ref={ref} onClick={() => setOpen((o) => !o)} aria-expanded={open}>abrir</button>
      <input aria-label="fuera" />
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} aria-label="pop" initialFocus={initialFocus}>
        <button>uno</button>
        <button>dos</button>
      </Popover>
    </div>
  );
}

describe("Popover", () => {
  it("opens with focus inside, closes on Escape and gives focus back to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "abrir" });
    await user.click(trigger);
    const pop = screen.getByRole("dialog", { name: "pop" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "uno" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pop.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("toggles from its trigger and closes on a press outside without stealing that focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "abrir" });
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(trigger);
    const outside = screen.getByRole("textbox", { name: "fuera" });
    await user.click(outside);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("sits on the popover layer and, inside a dialog, closes first", async () => {
    const user = userEvent.setup();
    const onDialogClose = vi.fn();
    render(
      <ModalLayer onClose={onDialogClose} aria-label="diálogo">
        <Harness />
      </ModalLayer>,
    );
    await user.click(screen.getByRole("button", { name: "abrir" }));
    const pop = screen.getByRole("dialog", { name: "pop" });
    expect(pop.className).toContain("k-popover");
    await user.click(screen.getByRole("button", { name: "dos" }));
    expect(onDialogClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "pop" })).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onDialogClose).toHaveBeenCalledTimes(1);
  });

  it("flips above its trigger when there is no room below", async () => {
    const user = userEvent.setup();
    const rect = (top: number, height: number, left = 100, width = 80) =>
      ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON() {} }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "dialog" ? rect(0, 200, 0, 160) : rect(window.innerHeight - 40, 30);
    });
    try {
      render(<Harness />);
      await user.click(screen.getByRole("button", { name: "abrir" }));
      const top = Number.parseFloat(screen.getByRole("dialog", { name: "pop" }).style.top);
      expect(top).toBeLessThan(window.innerHeight - 40);
    } finally {
      spy.mockRestore();
    }
  });
});
