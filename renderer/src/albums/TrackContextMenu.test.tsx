import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TrackContextMenu, { menuPointFrom, type MenuItem } from "./TrackContextMenu";

afterEach(cleanup);

function setup(items: MenuItem[], extra: Partial<React.ComponentProps<typeof TrackContextMenu>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <div style={{ containerType: "inline-size" }} data-testid="container">
      <TrackContextMenu open x={40} y={40} title="Song" artist="Artist" items={items} onClose={onClose} {...extra} />
    </div>,
  );
  return { onClose, ...utils };
}

describe("TrackContextMenu", () => {
  it("renders outside its (size-container) parent, so nothing can clip it", () => {
    setup([{ label: "Reproducir" }]);
    const menu = screen.getByRole("menu", { name: "Song" });
    expect(screen.getByTestId("container").contains(menu)).toBe(false);
    // Through the kit's Portal: a display:contents wrapper in the app's one layer root on <body>.
    expect(menu.parentElement?.parentElement?.id).toBe("krobi-layers");
    expect(menu.parentElement?.parentElement?.parentElement).toBe(document.body);
  });

  it("moves with the arrow keys, skipping separators and disabled rows, and wraps", () => {
    const play = vi.fn();
    const open = vi.fn();
    const { onClose } = setup([
      { label: "Reproducir", onClick: play },
      { type: "separator" },
      { label: "Abrir archivo", disabled: true, hint: "remoto" },
      { label: "Letra…", onClick: open },
    ]);
    const menu = screen.getByRole("menu", { name: "Song" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menu.getAttribute("aria-activedescendant")).toBe(screen.getByText("Reproducir").closest("[role=menuitem]")!.id);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menu.getAttribute("aria-activedescendant")).toBe(screen.getByText("Letra…").closest("[role=menuitem]")!.id);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menu.getAttribute("aria-activedescendant")).toBe(screen.getByText("Reproducir").closest("[role=menuitem]")!.id);
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    expect(play).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("does nothing for a disabled row", () => {
    const run = vi.fn();
    const { onClose } = setup([{ label: "Abrir archivo", disabled: true, onClick: run }]);
    fireEvent.click(screen.getByRole("menuitem"));
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens the submenu with → and leaves it with ←, and Escape backs out one level", () => {
    const vlc = vi.fn();
    const { onClose } = setup([
      { label: "Reproducir" },
      { label: "Enviar a", submenu: [{ label: "VLC", onClick: vlc }] },
    ]);
    const menu = screen.getByRole("menu", { name: "Song" });
    fireEvent.keyDown(menu, { key: "End" });
    fireEvent.keyDown(menu, { key: "ArrowRight" });
    const sub = screen.getByRole("menu", { name: "Enviar a" });
    expect(screen.getByText("Enviar a").closest("[role=menuitem]")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(sub, { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "Enviar a" })).toBeNull();
    fireEvent.keyDown(menu, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("menu", { name: "Enviar a" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(menu, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("menu", { name: "Enviar a" }), { key: "Enter" });
    expect(vlc).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it("jumps by typing the first letter", () => {
    setup([{ label: "Reproducir" }, { label: "Letra…" }, { label: "Añadir a la cola" }]);
    const menu = screen.getByRole("menu", { name: "Song" });
    fireEvent.keyDown(menu, { key: "l" });
    expect(menu.getAttribute("aria-activedescendant")).toBe(screen.getByText("Letra…").closest("[role=menuitem]")!.id);
  });

  it("closes on a press outside, on Escape and on user scroll", () => {
    const { onClose } = setup([{ label: "Reproducir" }]);
    fireEvent.pointerDown(document.body, { button: 0 });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Song" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.wheel(window);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("anchors a keyboard-opened menu (clientX/Y 0) to the element", () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ left: 100, top: 200, bottom: 230, right: 400, width: 300, height: 30, x: 100, y: 200, toJSON() {} });
    expect(menuPointFrom({ clientX: 0, clientY: 0, currentTarget: el })).toEqual({ x: 124, y: 230 });
    expect(menuPointFrom({ clientX: 5, clientY: 6, currentTarget: el })).toEqual({ x: 5, y: 6 });
  });
});
