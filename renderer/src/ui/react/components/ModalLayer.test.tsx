import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModalLayer } from "./ModalLayer";

function Harness({ dismissible = true, nested = false }: { dismissible?: boolean; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>abrir</button>
      <button>detrás</button>
      {open && (
        <ModalLayer onClose={() => setOpen(false)} aria-label="exterior" dismissible={dismissible}>
          <button>primero</button>
          <button>último</button>
          {nested && <button onClick={() => setInner(true)}>anidar</button>}
          {inner && (
            <ModalLayer onClose={() => setInner(false)} aria-label="interior">
              <button>dentro</button>
            </ModalLayer>
          )}
        </ModalLayer>
      )}
    </div>
  );
}

describe("ModalLayer", () => {
  it("takes focus in, keeps Tab inside and gives focus back to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "abrir" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "exterior" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "primero" }));
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("hides the page behind it from assistive technology while open, and renders into the layer root", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole("button", { name: "abrir" }));
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect(document.getElementById("krobi-layers")?.contains(screen.getByRole("dialog"))).toBe(true);
    await user.keyboard("{Escape}");
    expect(container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("closes only the innermost layer on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness nested />);
    await user.click(screen.getByRole("button", { name: "abrir" }));
    await user.click(screen.getByRole("button", { name: "anidar" }));
    expect(screen.getByRole("dialog", { name: "interior" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "interior" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "exterior" })).toBeTruthy();
  });

  it("closes on a press outside the panel, not inside it", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ModalLayer onClose={onClose} aria-label="d">
        <button>x</button>
      </ModalLayer>,
    );
    await user.click(screen.getByRole("button", { name: "x" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.pointer({ keys: "[MouseLeft]", target: document.querySelector(".k-scrim") as Element });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape and the scrim while not dismissible", async () => {
    const user = userEvent.setup();
    render(<Harness dismissible={false} />);
    await user.click(screen.getByRole("button", { name: "abrir" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "exterior" })).toBeTruthy();
  });

  it("unmounts after open goes false (no animation to wait for under jsdom)", () => {
    const { rerender } = render(
      <ModalLayer open onClose={() => {}} aria-label="d">
        <p>hola</p>
      </ModalLayer>,
    );
    expect(screen.getByRole("dialog").getAttribute("data-state")).toBe("open");
    rerender(
      <ModalLayer open={false} onClose={() => {}} aria-label="d">
        <p>hola</p>
      </ModalLayer>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ModalLayer with autoFocus inside", () => {
  it("keeps React's autoFocus and still gives focus back to the opener", async () => {
    const user = userEvent.setup();
    function AutoHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button onClick={() => setOpen(true)}>abrir</button>
          {open && (
            <ModalLayer onClose={() => setOpen(false)} aria-label="buscar">
              <button>cerrar</button>
              <input aria-label="búsqueda" autoFocus />
            </ModalLayer>
          )}
        </div>
      );
    }
    render(<AutoHarness />);
    const opener = screen.getByRole("button", { name: "abrir" });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "búsqueda" }));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
  });
});

it("keeps notification actions accessible and in the modal keyboard cycle", async () => {
  const { notify } = await import("../../notifications");
  const undo = vi.fn();
  const close = vi.fn();
  render(<ModalLayer onClose={close} aria-label="letra"><button onClick={() => notify({ message: "Guardada", action: { label: "Deshacer", onSelect: undo } })}>Guardar</button></ModalLayer>);
  await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
  const action = screen.getByRole("button", { name: "Deshacer" });
  await userEvent.tab();
  expect(action).toHaveFocus();
  await userEvent.click(action);
  expect(undo).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeVisible();
});
