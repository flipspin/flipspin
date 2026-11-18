import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ColumnPicker from "./ColumnPicker";
import { EmptySongColumnsContext, _resetForTest, getState, setColumnVisible, _reloadFromStorageForTest, type SongColumnId } from "../../library/tracks/songTableColumns";

describe("ColumnPicker", () => {
  afterEach(() => act(() => _resetForTest()));
  it("reorders hidden columns by grip, persists on release, and Show all only changes visibility", async () => {
    const user = userEvent.setup();
    act(() => setColumnVisible("artist", false));
    render(<ColumnPicker />);
    await user.click(screen.getByRole("button", { name: "Elegir columnas" }));
    const grip = screen.getByRole("button", { name: "Arrastrar Artista para reordenar" });
    const rows = [...document.querySelectorAll(".song-table-columns__row")];
    rows.forEach((row, i) => Object.defineProperties(row, { offsetTop: { value: i * 30 }, offsetHeight: { value: 30 } }));
    grip.setPointerCapture = () => {};
    const pointer = (type: string, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientY: y, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(grip, event);
    };
    pointer("pointerdown", 15);
    pointer("pointermove", 80);
    expect(rows[0]).toHaveClass("song-table-columns__row--lifted");
    expect(getState().order[0]).toBe("artist");
    pointer("pointerup", 80);
    expect(getState().order.slice(0, 3)).toEqual(["album", "genre", "artist"]);
    expect(screen.getByText("Movida a la posición 3 de 9")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("checkbox", { name: "Artista" })).not.toBeChecked();
    const locked = screen.getByText("Siempre visible").closest("li")!;
    expect(locked.querySelector("button")).toBeNull();
    expect(locked.parentElement!.firstElementChild).toBe(locked);
    await user.click(screen.getByRole("button", { name: "Mostrar todas" }));
    expect(getState().hidden).toEqual([]);
    expect(getState().order.slice(0, 3)).toEqual(["album", "genre", "artist"]);
    act(() => _reloadFromStorageForTest());
    expect(getState().order.slice(0, 3)).toEqual(["album", "genre", "artist"]);
  });

  it("moves the focused grip with arrows and Escape cancels a drag before dismissing the picker", async () => {
    const user = userEvent.setup();
    render(<ColumnPicker />);
    await user.click(screen.getByRole("button", { name: "Elegir columnas" }));
    const grip = screen.getByRole("button", { name: "Arrastrar Artista para reordenar" });
    grip.focus();
    await user.keyboard("{ArrowDown}");
    expect(getState().order.slice(0, 2)).toEqual(["album", "artist"]);
    expect(grip).toHaveFocus();
    expect(screen.getByText("Movida a la posición 2 de 9")).toBeInTheDocument();
    grip.setPointerCapture = () => {};
    const event = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 15, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(grip, event);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(grip.closest("li")).not.toHaveClass("song-table-columns__row--lifted");
    expect(getState().order.slice(0, 2)).toEqual(["album", "artist"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables empty columns with a muted vacía label and explanatory tooltip, without changing preferences", async () => {
    const user = userEvent.setup();
    const empty: SongColumnId[] = ["genre", "key", "bpm", "date", "analysis", "lyrics"];
    const { rerender } = render(<EmptySongColumnsContext.Provider value={empty}><ColumnPicker /></EmptySongColumnsContext.Provider>);
    await user.click(screen.getByRole("button", { name: "Elegir columnas" }));
    for (const label of ["Género", "Tono", "BPM", "Fecha", "Info", "Letra"]) {
      const checkbox = screen.getByRole("checkbox", { name: new RegExp(label) });
      expect(checkbox).toBeDisabled();
      expect(checkbox).not.toBeChecked();
      expect(checkbox.closest("label")).toHaveAttribute("title", `Ninguna canción de esta lista tiene ${label}`);
      expect(checkbox.closest("label")?.querySelector(".song-table-columns__empty")).toHaveTextContent("vacía");
      await user.click(checkbox);
    }
    expect(getState().hidden).toEqual([]);
    expect(screen.getByRole("button", { name: "Mostrar todas" })).toBeDisabled();
    expect(screen.getByText("4/11")).toBeTruthy();
    rerender(<EmptySongColumnsContext.Provider value={[]}><ColumnPicker /></EmptySongColumnsContext.Provider>);
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeChecked();
  });

  it("keeps auto-hidden columns hidden after Mostrar todas while preserving the choice when data returns", async () => {
    const user = userEvent.setup();
    act(() => setColumnVisible("genre", false));
    const { rerender } = render(<EmptySongColumnsContext.Provider value={["genre"]}><ColumnPicker /></EmptySongColumnsContext.Provider>);
    await user.click(screen.getByRole("button", { name: "Elegir columnas" }));
    await user.click(screen.getByRole("button", { name: "Mostrar todas" }));
    expect(getState().hidden).toEqual([]);
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeDisabled();
    act(() => setColumnVisible("genre", false));
    rerender(<EmptySongColumnsContext.Provider value={[]}><ColumnPicker /></EmptySongColumnsContext.Provider>);
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /Género/ })).not.toBeChecked();
  });
  it("toggles Portadas for its own table and restores the artist checkbox", async () => {
    const user = userEvent.setup();
    render(<ColumnPicker kind="playlist" />);
    await user.click(screen.getByRole("button", { name: "Elegir columnas" }));
    const covers = screen.getByRole("checkbox", { name: "Portadas" });
    const artist = screen.getByRole("checkbox", { name: /Artista/ });
    expect(covers).toBeChecked();
    expect(artist).toBeDisabled();
    expect(artist).not.toBeChecked();
    await user.click(covers);
    expect(artist).toBeEnabled();
    expect(artist).toBeChecked();
    expect(getState().covers).toEqual({ playlist: false, library: false });
  });
  it("opens on the kit's popover, Escape closes it and focus goes back to the trigger", async () => {
    const user = userEvent.setup();
    render(<ColumnPicker />);
    const trigger = screen.getByRole("button", { name: "Elegir columnas" });
    await user.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Columnas de la tabla" });
    expect(panel.className).toContain("k-popover");
    expect(panel.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
