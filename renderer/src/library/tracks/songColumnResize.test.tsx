import React, { Profiler } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SongTableHeader from "./SongTableHeader";
import ColumnPicker from "../../ui/components/ColumnPicker";
import {
  _reloadFromStorageForTest, _resetForTest, clampSongColumnWidth, getState,
  normalizeSongColumnWidths, resetColumnWidths, setColumnOrder, setColumnWidths, setColumnVisible, songColumnMin,
  type SongWidthId, type SongColumnId,
} from "./songTableColumns";
import { fittedSongColumnWidth } from "./useSongColumnResize";
import css from "../../styles/retro-song-table.css?raw";

const sizes = { title: 240, artist: 140, album: 180, genre: 140, date: 108, analysis: 68, key: 208, bpm: 76, lyrics: 140, duration: 92 };
let titleSpace: number;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let capture: number | undefined;
let writes: ReturnType<typeof vi.spyOn>;
const initialWidths = Object.fromEntries(Object.entries(sizes).filter(([id]) => id !== "title" && id !== "lyrics"));

// Model the grid: fixed tracks use root vars, Title receives the remaining space.
// Boundaries therefore expose regressions that only changing one width would miss.
function bounds(cell: HTMLElement) {
  const root = cell.closest<HTMLElement>(".retro-song-table");
  const visible = getState().order.filter(id => root && !root.classList.contains(`song-table--hide-${id}`)
    && (id !== "lyrics" || root.classList.contains("song-table--lyrics")));
  const widthOf = (id: SongColumnId) => Number.parseFloat(root?.style.getPropertyValue(`--sc-w-${id}`) || String(sizes[id]));
  const title = titleSpace + visible.reduce((sum, id) => sum + sizes[id] - widthOf(id), 0);
  const id = cell.dataset.resizeColumn as SongWidthId;
  const width = id === "title" ? title : visible.includes(id) ? widthOf(id) : 0;
  const index = visible.indexOf(id as SongColumnId);
  const left = id === "title" ? 0 : title + visible.slice(0, Math.max(0, index)).reduce((sum, id) => sum + widthOf(id), 0);
  return { x: left, y: 0, top: 0, left, right: left + width, bottom: 24, width, height: 24, toJSON() {} };
}

beforeEach(() => {
  _resetForTest();
  titleSpace = sizes.title;
  frames = new Map(); nextFrame = 0; capture = undefined;
  vi.stubGlobal("requestAnimationFrame", vi.fn((fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return bounds(this);
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: vi.fn((text: string) => ({ width: text.length * 10 })) } as unknown as CanvasRenderingContext2D);
  // jsdom Storage is a proxy: spy on its prototype, while the Node shim
  // supplies ordinary own methods. An instance spy on jsdom records no calls.
  const storage = Object.hasOwn(localStorage, "setItem") ? localStorage : Object.getPrototypeOf(localStorage);
  writes = vi.spyOn(storage, "setItem");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); _resetForTest(); });

function table(onRender = vi.fn(), onSort = vi.fn()) {
  const view = render(<div className="retro-song-table"><Profiler id="table" onRender={onRender}>
    <SongTableHeader onSort={onSort} />
    <div className="retro-song-table__row song-grid"><div className="song-col--album">Album</div></div>
  </Profiler></div>);
  const root = view.container.firstElementChild as HTMLElement;
  return { ...view, root, onRender, onSort };
}
function handle(id = "album") {
  const element = document.querySelector<HTMLElement>(`[data-column-id=${id}]`)!;
  element.setPointerCapture = vi.fn((id: number) => { capture = id; });
  element.hasPointerCapture = vi.fn((id: number) => capture === id);
  element.releasePointerCapture = vi.fn(() => { capture = undefined; });
  return element;
}
function pointer(element: HTMLElement, type: string, x: number, buttons = 1, pointerId = 7) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(element, event);
}
function frame() { act(() => { const queued = [...frames.values()]; frames.clear(); queued.forEach(fn => fn(0)); }); }

describe("column resize", () => {
  it("restores Title's right separator while keeping sorting on its label", () => {
    const { root, onSort } = table();
    const title = root.querySelector(".song-col--title")!;
    expect(title.querySelector('[role="separator"]')).toBe(handle("title"));
    expect(handle("title")).toHaveAttribute("data-resize-side", "right");
    const label = screen.getByRole("button", { name: /Título/ });
    fireEvent.click(label);
    expect(onSort).toHaveBeenCalledWith("title");
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Enter"]) fireEvent.keyDown(label, { key });
    expect(getState().widths).toEqual({});
    expect(root.style.getPropertyValue("--sc-w-title")).toBe("");
    expect(writes).not.toHaveBeenCalled();
  });
  it.each(["title", "artist", "album"])("freezes flexible siblings on %s press without moving or saving; restores a plain click", id => {
    const { root } = table(); const zone = handle(id);
    pointer(zone, "pointerdown", 100);
    expect(zone.setPointerCapture).toHaveBeenCalledWith(7);
    expect(root.style.getPropertyValue("--sc-w-artist")).toBe("140px");
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("180px");
    expect(root.style.getPropertyValue("--sc-w-title")).toBe("");
    expect(document.documentElement).toHaveClass("song-column-resizing");
    expect(getState().widths).toEqual({});
    pointer(zone, "pointerup", 100, 0);
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("");
    expect(getState().widths).toEqual({});
    expect(writes).not.toHaveBeenCalled();
  });
  it("keeps Title's edge under the pointer in both directions, saving only its neighbours on release", () => {
    const { root, onRender, onSort } = table(); const zone = handle("title");
    const title = zone.parentElement!;
    const before = title.getBoundingClientRect();
    pointer(zone, "pointerdown", before.right);
    const renders = onRender.mock.calls.length;
    for (const delta of [30, 150, 400, -60]) {
      pointer(zone, "pointermove", before.right + delta); frame();
      expect(title.getBoundingClientRect().right).toBe(before.right + delta);
      expect(title.getBoundingClientRect().left).toBe(before.left);
      expect(zone).toHaveAttribute("aria-valuenow", String(before.width + delta));
      expect(root.style.getPropertyValue("--sc-w-title")).toBe("");
      expect(getState().widths).not.toHaveProperty("title");
      expect(writes).not.toHaveBeenCalled();
      expect(onRender).toHaveBeenCalledTimes(renders);
    }
    pointer(zone, "pointerup", before.right - 60, 0);
    expect(getState().widths).toEqual({ ...initialWidths, artist: 200 });
    expect(JSON.parse(localStorage.getItem("krobi.songTable.columnWidths")!)).toEqual({ ...initialWidths, artist: 200 });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(title.getBoundingClientRect().right).toBe(before.right - 60);
    expect(onSort).not.toHaveBeenCalled();
  });
  it("drains Title's right neighbours nearest first and stops only when they reach minimum", () => {
    const minimums = Object.fromEntries(getState().order.filter(id => id !== "lyrics").map(id => [id, songColumnMin(id)]));
    setColumnWidths({ ...minimums, artist: 60, album: 54, genre: 52 });
    const { root } = table(); const zone = handle("title");
    const before = zone.parentElement!.getBoundingClientRect().right;
    pointer(zone, "pointerdown", before);
    for (const [delta, artist, album, genre] of [[10, 50, 54, 52], [15, 48, 51, 52], [21, 48, 48, 49], [1000, 48, 48, 48]]) {
      pointer(zone, "pointermove", before + delta); frame();
      expect(root.style.getPropertyValue("--sc-w-artist")).toBe(`${artist}px`);
      expect(root.style.getPropertyValue("--sc-w-album")).toBe(`${album}px`);
      expect(root.style.getPropertyValue("--sc-w-genre")).toBe(`${genre}px`);
      expect(zone.parentElement!.getBoundingClientRect().right).toBe(before + Math.min(delta, 22));
    }
    pointer(zone, "pointerup", before + 1000, 0);
    expect(getState().widths).toEqual(minimums);
    expect(JSON.parse(localStorage.getItem("krobi.songTable.columnWidths")!)).toEqual(minimums);
  });
  it("gives Title's shrinking width to right neighbours up to 600 each, respecting its floor", () => {
    titleSpace = 1200;
    setColumnWidths({ artist: 590, album: 598 });
    const { root } = table(); const zone = handle("title");
    const before = zone.parentElement!.getBoundingClientRect().right;
    pointer(zone, "pointerdown", before); pointer(zone, "pointermove", before - 20); frame();
    expect(root.style.getPropertyValue("--sc-w-artist")).toBe("600px");
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("600px");
    expect(root.style.getPropertyValue("--sc-w-genre")).toBe("148px");
    expect(zone.parentElement!.getBoundingClientRect().right).toBe(before - 20);
    pointer(zone, "pointermove", -1000); frame();
    expect(zone.parentElement!.getBoundingClientRect().width).toBe(160);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(getState().widths).toEqual({ artist: 590, album: 598 });
    expect(zone.parentElement!.getBoundingClientRect().right).toBe(before);
  });
  it("uses visible visual order for Title and leaves hidden neighbours' preferences alone", () => {
    setColumnWidths({ artist: 300 });
    setColumnOrder(["artist", "bpm", "album"]);
    const { root } = table(); root.classList.add("song-table--hide-artist");
    const zone = handle("title");
    const before = zone.parentElement!.getBoundingClientRect().right;
    pointer(zone, "pointerdown", before); pointer(zone, "pointermove", before + 50); frame();
    expect(zone.parentElement!.getBoundingClientRect().right).toBe(before + 50);
    expect(root.style.getPropertyValue("--sc-w-artist")).toBe("300px");
    expect(root.style.getPropertyValue("--sc-w-bpm")).toBe("40px");
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("166px");
    pointer(zone, "pointerup", before + 50, 0);
    expect(getState().widths).not.toHaveProperty("title");
    expect(getState().widths.artist).toBe(300);
  });
  it("supports Title arrows, Shift, Home and End by resizing neighbours without sorting or saving Title", () => {
    const { root, onSort } = table(); const zone = handle("title"); zone.focus();
    const title = zone.parentElement!;
    expect(zone).toHaveAttribute("aria-valuemin", "160");
    expect(zone).toHaveAttribute("aria-valuemax", "884");
    for (const [key, shiftKey, titleWidth, artist] of [
      ["ArrowRight", false, 248, 132], ["ArrowLeft", true, 208, 172],
      ["ArrowLeft", false, 200, 180], ["ArrowRight", true, 240, 140],
      ["Home", false, 160, 220],
    ] as const) {
      fireEvent.keyDown(zone, { key, shiftKey });
      expect(title.getBoundingClientRect().width).toBe(titleWidth);
      expect(getState().widths.artist).toBe(artist);
      expect(zone).toHaveAttribute("aria-valuenow", String(titleWidth));
    }
    fireEvent.keyDown(zone, { key: "End" });
    expect(title.getBoundingClientRect().width).toBe(884);
    for (const [id, width] of Object.entries(getState().widths)) expect(width).toBe(songColumnMin(id as SongColumnId));
    expect(root.style.getPropertyValue("--sc-w-title")).toBe("");
    expect(getState().widths).not.toHaveProperty("title");
    for (const [, raw] of writes.mock.calls) expect(JSON.parse(raw as string)).not.toHaveProperty("title");
    expect(onSort).not.toHaveBeenCalled();
  });
  it.each(["double-click", "Enter"])("fits Title's content through its neighbours using %s", action => {
    const { root, onSort } = table(); const zone = handle("title");
    const row = root.querySelector(".retro-song-table__row")!;
    row.innerHTML = '<div class="song-col--title">' + "x".repeat(40) + '</div>';
    const fit = () => action === "Enter" ? fireEvent.keyDown(zone, { key: "Enter" }) : fireEvent.doubleClick(zone);
    fit();
    expect(zone.parentElement!.getBoundingClientRect().width).toBe(424);
    expect(getState().widths).toEqual({ ...initialWidths, artist: 48, album: 88 });
    fit();
    expect(zone.parentElement!.getBoundingClientRect().width).toBe(424);
    row.firstElementChild!.textContent = "x".repeat(200);
    fit();
    expect(zone.parentElement!.getBoundingClientRect().width).toBe(884);
    row.firstElementChild!.textContent = "Short";
    fit();
    expect(zone.parentElement!.getBoundingClientRect().width).toBe(160);
    expect(getState().widths.artist).toBe(600);
    expect(getState().widths.album).toBe(220);
    expect(getState().widths).not.toHaveProperty("title");
    expect(JSON.parse(localStorage.getItem("krobi.songTable.columnWidths")!)).not.toHaveProperty("title");
    expect(onSort).not.toHaveBeenCalled();
  });
  it("stops Title shrinking when every right neighbour is already at 600", () => {
    titleSpace = 5000;
    setColumnWidths(Object.fromEntries(getState().order.map(id => [id, 600])));
    const { root } = table(); const zone = handle("title");
    const before = zone.parentElement!.getBoundingClientRect().right;
    pointer(zone, "pointerdown", before); pointer(zone, "pointermove", before - 100); frame();
    expect(zone.parentElement!.getBoundingClientRect().right).toBe(before);
    pointer(zone, "pointerup", before - 100, 0);
    fireEvent.keyDown(zone, { key: "Home" });
    expect(zone.parentElement!.getBoundingClientRect().right).toBe(before);
    expect(root.style.getPropertyValue("--sc-w-title")).toBe("");
    expect(getState().widths).not.toHaveProperty("title");
  });
  it("shows Title's zone with one visible neighbour and hides it when none remain", async () => {
    const { root } = table(); const zone = handle("title");
    await act(async () => {
      getState().order.filter(id => id !== "album").forEach(id => root.classList.add(`song-table--hide-${id}`));
    });
    expect(zone).toBeVisible();
    fireEvent.keyDown(zone, { key: "ArrowRight" });
    expect(getState().widths).toEqual({ album: 172 });
    expect(zone.parentElement!.getBoundingClientRect().width).toBe(248);
    await act(async () => { root.classList.add("song-table--hide-album"); });
    expect(zone).not.toBeVisible();
    writes.mockClear();
    fireEvent.keyDown(zone, { key: "End" });
    expect(writes).not.toHaveBeenCalled();
  });
  it("batches moves into one root style write per frame, never renders React, and saves only on release", () => {
    const { root, onRender, onSort } = table(); const zone = handle();
    expect(root.style.getPropertyValue("--sc-min-rest")).toBe("368px");
    pointer(zone, "pointerdown", 100);
    const renders = onRender.mock.calls.length;
    const styleWrite = vi.spyOn(root.style, "cssText", "set");
    for (let x = 101; x <= 130; x++) pointer(zone, "pointermove", x);
    expect(styleWrite).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    frame();
    expect(styleWrite).toHaveBeenCalledTimes(1);
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("210px");
    expect(root.style.getPropertyValue("--sc-w-genre")).toBe("110px");
    expect(root.style.getPropertyValue("--sc-w-title")).toBe("");
    expect(onRender).toHaveBeenCalledTimes(renders);
    expect(writes).not.toHaveBeenCalled();
    for (let x = 131; x <= 250; x++) pointer(zone, "pointermove", x);
    expect(styleWrite).toHaveBeenCalledTimes(1);
    frame();
    expect(styleWrite).toHaveBeenCalledTimes(2);
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("330px");
    expect(root.style.getPropertyValue("--sc-w-genre")).toBe("48px");
    expect(root.style.getPropertyValue("--sc-w-date")).toBe("50px");
    expect(onRender).toHaveBeenCalledTimes(renders);
    pointer(zone, "pointerup", 250, 0);
    expect(styleWrite).toHaveBeenCalledTimes(2);
    expect(getState().widths).toEqual({ ...initialWidths, album: 330, genre: 48, date: 50 });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("krobi.songTable.columnWidths")!)).toEqual({ ...initialWidths, album: 330, genre: 48, date: 50 });
    fireEvent.click(zone);
    expect(onSort).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("song-column-resizing");
  });
  it("moves the dragged right boundary by the pointer delta while Title and the left tracks stay still", () => {
    const { root } = table(); const zone = handle();
    const album = zone.parentElement!;
    const title = root.querySelector<HTMLElement>(".song-col--title")!;
    const before = album.getBoundingClientRect();
    const titleWidth = title.getBoundingClientRect().width;
    pointer(zone, "pointerdown", before.right);
    expect(title.getBoundingClientRect().width).toBe(titleWidth);
    for (const delta of [30, 150, 400, -120, 0]) {
      pointer(zone, "pointermove", before.right + delta); frame();
      expect(album.getBoundingClientRect().right).toBe(before.right + delta);
      expect(album.getBoundingClientRect().left).toBe(before.left);
      expect(title.getBoundingClientRect().width).toBe(titleWidth);
    }
    pointer(zone, "pointerup", before.right, 0);
    expect(title.getBoundingClientRect().width).toBe(titleWidth);
  });
  it("drains right neighbours in order and clamps the boundary when they all reach minimum", () => {
    const minimums = Object.fromEntries(getState().order.filter(id => id !== "lyrics").map(id => [id, songColumnMin(id)]));
    setColumnWidths({ ...minimums, artist: 140, album: 180, genre: 60, date: 54, analysis: 44 });
    const { root } = table(); const zone = handle();
    const before = zone.parentElement!.getBoundingClientRect().right;
    const title = root.querySelector<HTMLElement>(".song-col--title")!;
    const titleWidth = title.getBoundingClientRect().width;
    pointer(zone, "pointerdown", before);
    for (const [delta, genre, date, analysis] of [[10, 50, 54, 44], [15, 48, 51, 44], [21, 48, 48, 41], [100, 48, 48, 40]]) {
      pointer(zone, "pointermove", before + delta); frame();
      expect(root.style.getPropertyValue("--sc-w-genre")).toBe(`${genre}px`);
      expect(root.style.getPropertyValue("--sc-w-date")).toBe(`${date}px`);
      expect(root.style.getPropertyValue("--sc-w-analysis")).toBe(`${analysis}px`);
      expect(zone.parentElement!.getBoundingClientRect().right).toBe(before + Math.min(delta, 22));
      expect(title.getBoundingClientRect().width).toBe(titleWidth);
    }
    pointer(zone, "pointerup", before + 100, 0);
    expect(getState().widths).toEqual({ ...minimums, artist: 140, album: 202 });
  });
  it("gives shrinking width to the nearest right neighbour up to 600, then the next", () => {
    setColumnWidths({ genre: 590, date: 598 });
    const { root } = table(); const zone = handle();
    const title = root.querySelector<HTMLElement>(".song-col--title")!;
    const titleWidth = title.getBoundingClientRect().width;
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 80); frame();
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("160px");
    expect(root.style.getPropertyValue("--sc-w-genre")).toBe("600px");
    expect(root.style.getPropertyValue("--sc-w-date")).toBe("600px");
    expect(root.style.getPropertyValue("--sc-w-analysis")).toBe("76px");
    expect(title.getBoundingClientRect().width).toBe(titleWidth);
    fireEvent.keyDown(document, { key: "Escape" });
  });
  it("clamps shrinking when no right neighbour can grow", () => {
    setColumnWidths({ ...Object.fromEntries(getState().order.map(id => [id, 600])), album: 180 });
    const { root } = table(); const zone = handle();
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 0); frame();
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("180px");
    fireEvent.keyDown(document, { key: "Escape" });
  });
  it("uses visible visual order, skipping hidden neighbours and preserving their preferences", () => {
    setColumnWidths({ genre: 300 });
    setColumnOrder(["artist", "album", "genre", "bpm", "duration"]);
    const { root } = table(); root.classList.add("song-table--hide-genre");
    const zone = handle();
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 150); frame();
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("230px");
    expect(root.style.getPropertyValue("--sc-w-genre")).toBe("300px");
    expect(root.style.getPropertyValue("--sc-w-bpm")).toBe("40px");
    expect(root.style.getPropertyValue("--sc-w-duration")).toBe("78px");
    pointer(zone, "pointerup", 150, 0);
    expect(getState().widths.genre).toBe(300);
    expect(getState().widths.bpm).toBe(40);
  });
  it("moves the last column's left boundary with the pointer and takes space from the left", () => {
    const { root } = table(); const zone = handle("duration");
    expect(zone).toHaveAttribute("data-resize-side", "left");
    const before = zone.parentElement!.getBoundingClientRect();
    const title = root.querySelector<HTMLElement>(".song-col--title")!;
    const titleWidth = title.getBoundingClientRect().width;
    pointer(zone, "pointerdown", before.left);
    pointer(zone, "pointermove", before.left - 40); frame();
    expect(zone.parentElement!.getBoundingClientRect().left).toBe(before.left - 40);
    expect(zone.parentElement!.getBoundingClientRect().right).toBe(before.right);
    expect(root.style.getPropertyValue("--sc-w-duration")).toBe("132px");
    expect(root.style.getPropertyValue("--sc-w-bpm")).toBe("40px");
    expect(root.style.getPropertyValue("--sc-w-key")).toBe("204px");
    expect(title.getBoundingClientRect().width).toBe(titleWidth);
    pointer(zone, "pointermove", before.left + 70); frame();
    expect(zone.parentElement!.getBoundingClientRect().left).toBe(before.left + 44);
    expect(root.style.getPropertyValue("--sc-w-bpm")).toBe("120px");
    expect(root.style.getPropertyValue("--sc-w-duration")).toBe("48px");
    fireEvent.keyDown(document, { key: "Escape" });
  });
  it("mirrors last-column keyboard arrows and shares the transfer rule for Home, End and Enter", () => {
    const { root } = table(); const zone = handle("duration");
    const title = root.querySelector<HTMLElement>(".song-col--title")!;
    const titleWidth = title.getBoundingClientRect().width;
    fireEvent.keyDown(zone, { key: "ArrowLeft" });
    expect(getState().widths.duration).toBe(100);
    expect(getState().widths.bpm).toBe(68);
    fireEvent.keyDown(zone, { key: "ArrowRight", shiftKey: true });
    expect(getState().widths.duration).toBe(60);
    expect(getState().widths.bpm).toBe(108);
    fireEvent.keyDown(zone, { key: "Home" }); expect(getState().widths.duration).toBe(48);
    fireEvent.keyDown(zone, { key: "End" }); expect(getState().widths.duration).toBe(600);
    root.querySelector(".retro-song-table__row")!.innerHTML = '<div class="song-col--duration">1:23</div>';
    fireEvent.keyDown(zone, { key: "Enter" }); expect(getState().widths.duration).toBe(104);
    expect(title.getBoundingClientRect().width).toBe(titleWidth);
  });
  it("fits only as far as neighbours can supply, by double-click and Enter", () => {
    const minimums = Object.fromEntries(getState().order.filter(id => id !== "lyrics").map(id => [id, songColumnMin(id)]));
    setColumnWidths({ ...minimums, album: 180, genre: 55, date: 50 });
    const { root } = table(); const zone = handle();
    root.querySelector(".retro-song-table__row .song-col--album")!.textContent = "x".repeat(100);
    const title = root.querySelector<HTMLElement>(".song-col--title")!;
    const titleWidth = title.getBoundingClientRect().width;
    fireEvent.doubleClick(zone);
    expect(getState().widths).toEqual({ ...minimums, album: 189 });
    expect(title.getBoundingClientRect().width).toBe(titleWidth);
    fireEvent.keyDown(zone, { key: "Enter" });
    expect(getState().widths.album).toBe(189);
  });
  it("hides the sole fixed column's zone rather than transferring space to Title", async () => {
    const { root } = table();
    await act(async () => {
      getState().order.filter(id => id !== "album").forEach(id => root.classList.add(`song-table--hide-${id}`));
    });
    const zone = handle();
    expect(zone).not.toBeVisible();
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 150); frame();
    fireEvent.keyDown(zone, { key: "End" });
    expect(getState().widths).toEqual({});
    expect(writes).not.toHaveBeenCalled();
  });
  it("activates shrinkable tracks even when Artist and Album are both hidden", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const id = this.dataset.resizeColumn as SongWidthId;
      const width = id === "artist" || id === "album" ? 0 : sizes[id] ?? 0;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 24, width, height: 24, toJSON() {} };
    });
    const { root } = table(); const zone = handle("analysis");
    pointer(zone, "pointerdown", 100);
    expect(root).toHaveAttribute("data-column-widths");
    expect(getState().widths).toEqual({});
    pointer(zone, "pointerup", 100, 0);
    expect(root).not.toHaveAttribute("data-column-widths");
  });
  it("keeps separator values within their bounds when flexible Artist has spare space", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 24, width: 900, height: 24, toJSON() {} });
    table();
    expect(handle("artist")).toHaveAttribute("aria-valuenow", "600");
  });
  it("clamps each move, including a final queued frame", () => {
    const { root } = table(); const zone = handle();
    pointer(zone, "pointerdown", 100);
    pointer(zone, "pointermove", -1000); frame();
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("48px");
    pointer(zone, "pointermove", 10000); pointer(zone, "pointerup", 10000, 0);
    expect(getState().widths.album).toBe(600);
  });
  it("Escape restores all press widths, cancels pending frames and never saves", () => {
    setColumnWidths({ album: 190 }); writes.mockClear();
    const { root } = table(); const zone = handle();
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 250); frame();
    expect(root.style.getPropertyValue("--sc-w-genre")).toBe("48px");
    expect(root.style.getPropertyValue("--sc-w-date")).toBe("50px");
    pointer(zone, "pointermove", 260);
    fireEvent.keyDown(document, { key: "Escape" }); frame();
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("190px");
    expect(root.style.getPropertyValue("--sc-w-artist")).toBe("");
    for (const id of getState().order.filter(id => id !== "album")) expect(root.style.getPropertyValue(`--sc-w-${id}`)).toBe("");
    expect(getState().widths).toEqual({ album: 190 });
    expect(writes).not.toHaveBeenCalled();
    expect(capture).toBeUndefined();
    expect(document.documentElement).not.toHaveClass("song-column-resizing");
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 120); frame();
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("210px");
    fireEvent.keyDown(document, { key: "Escape" });
  });
  it("finishes on buttons=0, ignores other pointers, and cancels on capture loss and unmount", () => {
    const { root, unmount } = table(); const zone = handle();
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 500, 1, 8); frame();
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("180px");
    pointer(zone, "pointermove", 120); pointer(zone, "pointermove", 200, 0);
    expect(getState().widths.album).toBe(200);
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 140); frame();
    fireEvent.lostPointerCapture(zone);
    expect(root.style.getPropertyValue("--sc-w-album")).toBe("200px");
    pointer(zone, "pointerdown", 100); pointer(zone, "pointermove", 140);
    unmount(); frame();
    expect(document.documentElement).not.toHaveClass("song-column-resizing");
    expect(getState().widths.album).toBe(200);
  });
  it("supports arrows, Shift arrows, Home, End and Enter without sorting", () => {
    const { onSort } = table(); const zone = handle(); zone.focus();
    expect(zone).toHaveAttribute("aria-orientation", "vertical");
    expect(zone).toHaveAttribute("aria-label", "Cambiar ancho de Álbum");
    expect(zone).toHaveAttribute("aria-valuemin", "48");
    expect(zone).toHaveAttribute("aria-valuemax", "600");
    fireEvent.keyDown(zone, { key: "ArrowRight" }); expect(getState().widths.album).toBe(188);
    fireEvent.keyDown(zone, { key: "ArrowLeft", shiftKey: true }); expect(getState().widths.album).toBe(148);
    fireEvent.keyDown(zone, { key: "ArrowLeft" }); expect(getState().widths.album).toBe(140);
    fireEvent.keyDown(zone, { key: "ArrowRight", shiftKey: true }); expect(getState().widths.album).toBe(180);
    fireEvent.keyDown(zone, { key: "Home" }); expect(getState().widths.album).toBe(48);
    fireEvent.keyDown(zone, { key: "End" }); expect(getState().widths.album).toBe(600);
    expect(zone).toHaveAttribute("aria-valuenow", "600");
    fireEvent.keyDown(zone, { key: "Enter" }); expect(getState().widths.album).toBe(74);
    fireEvent.keyDown(zone, { key: "Enter" }); expect(getState().widths.album).toBe(74);
    expect(onSort).not.toHaveBeenCalled();
  });
  it("fits rendered text using its font, ignores values above twice the median and remains fitted", () => {
    const { root } = table(); const zone = handle();
    const row = (text: string) => {
      const node = document.createElement("div"); node.className = "retro-song-table__row song-grid";
      const cell = document.createElement("div"); cell.className = "song-col--album"; cell.style.font = "400 14px sans-serif"; cell.textContent = text;
      node.append(cell); root.append(node);
    };
    row("123456"); row("1234567"); row("x".repeat(100));
    fireEvent.doubleClick(zone);
    expect(getState().widths.album).toBe(94);
    const context = document.createElement("canvas").getContext("2d")!;
    expect(context.measureText).toHaveBeenCalledTimes(5);
    expect(context.font).toContain("14px");
    fireEvent.doubleClick(zone);
    expect(getState().widths.album).toBe(94);
  });
  it("does not fit before rows exist; measures Album text once rows exist", () => {
    const { root } = table();
    root.querySelector(".retro-song-table__row")!.remove();
    expect(fittedSongColumnWidth(root, "album")).toBeUndefined();
    const row = document.createElement("div"); row.className = "retro-song-table__row song-grid";
    row.innerHTML = '<div class="song-col--album">Short</div>';
    root.append(row);
    expect(fittedSongColumnWidth(root, "album")).toBe(74);
  });
  it("places the last visible zone on its left edge, follows order, and keeps sorting on the label", () => {
    const { onSort } = table();
    expect(handle("duration")).toBeVisible();
    expect(handle("duration")).toHaveAttribute("data-resize-side", "left");
    expect(handle("artist")).toBeVisible();
    act(() => setColumnOrder(["duration", "artist", "album", "genre", "date", "analysis", "key", "bpm", "lyrics"]));
    expect(handle("lyrics")).not.toBeVisible();
    expect(handle("bpm")).toHaveAttribute("data-resize-side", "left");
    expect(handle("duration")).toBeVisible();
    expect(handle("duration")).toHaveAttribute("data-resize-side", "right");
    // The DOM order is stable; CSS named grid tracks provide the visual order.
    fireEvent.click(screen.getByRole("button", { name: /Artista/ }));
    expect(onSort).toHaveBeenCalledWith("artist");
  });
  it("handles a key once when two tables share the device store", () => {
    const view = render(<><div className="retro-song-table"><SongTableHeader /></div><div className="retro-song-table"><SongTableHeader kind="playlist" /></div></>);
    const zone = screen.getAllByRole("separator", { name: "Cambiar ancho de Álbum" })[0];
    fireEvent.keyDown(zone, { key: "ArrowRight" });
    expect(getState().widths.album).toBe(188);
    view.container.querySelectorAll<HTMLElement>(".retro-song-table").forEach(root => expect(root.style.getPropertyValue("--sc-w-album")).toBe("188px"));
  });
  it("reset widths in the picker resets both mounted tables, preserving order and hidden choices", () => {
    setColumnWidths({ album: 300, artist: 200 });
    setColumnVisible("genre", false);
    setColumnOrder(["album", "artist", "duration"]);
    const order = getState().order;
    const view = render(<><div className="retro-song-table"><SongTableHeader /></div><div className="retro-song-table"><SongTableHeader kind="playlist" /></div><ColumnPicker /></>);
    fireEvent.click(screen.getAllByRole("button", { name: "Elegir columnas" })[2]);
    fireEvent.click(screen.getByRole("button", { name: "Restablecer anchos" }));
    expect(getState().widths).toEqual({});
    expect(getState().order).toBe(order);
    expect(getState().hidden).toEqual(["genre"]);
    view.container.querySelectorAll<HTMLElement>(".retro-song-table").forEach(root => expect(root.style.getPropertyValue("--sc-w-album")).toBe(""));
  });
});

describe("width preferences and CSS", () => {
  it("normalizes ids and numbers, clamps every column, and survives corrupt storage independently", () => {
    expect(normalizeSongColumnWidths({ album: 900, title: 20, bpm: 0, analysis: 1, genre: 1, unknown: 200, artist: "180", key: Infinity, date: NaN })).toEqual({ album: 600, genre: 48, analysis: 40, bpm: 40 });
    expect(normalizeSongColumnWidths([])).toEqual({});
    localStorage.setItem("krobi.songTable.columnWidths", '{"album":250,"title":400,"bogus":1}');
    _reloadFromStorageForTest(); expect(getState().widths).toEqual({ album: 250 });
    resetColumnWidths(); expect(getState().widths).toEqual({});
    for (const raw of ["null", "[]", "broken", "42"]) {
      localStorage.setItem("krobi.songTable.columnWidths", raw);
      _reloadFromStorageForTest(); expect(getState().widths).toEqual({});
    }
    expect(clampSongColumnWidth("title", 0)).toBe(160);
    expect(clampSongColumnWidth("analysis", 0)).toBe(40);
    expect(clampSongColumnWidth("bpm", 0)).toBe(40);
    expect(clampSongColumnWidth("artist", 1000)).toBe(600);
  });
  it("ignores a stored Title width in the layout and never saves it again", () => {
    localStorage.setItem("krobi.songTable.columnWidths", '{"title":400}');
    _reloadFromStorageForTest();
    const { root } = table();
    expect(getState().widths).toEqual({});
    expect(root.style.getPropertyValue("--sc-w-title")).toBe("");
    expect(root).not.toHaveAttribute("data-column-widths");
    fireEvent.keyDown(handle("artist"), { key: "ArrowRight" });
    expect(JSON.parse(localStorage.getItem("krobi.songTable.columnWidths")!)).toEqual({ ...initialWidths, artist: 148, album: 172 });
  });
  it("keeps user variables separate from hide rules, with container rules later at equal specificity", () => {
    expect(css).toContain("--sc-album: var(--sc-w-album, minmax(7.75rem, 1fr));");
    const resized = css.indexOf(":where(.retro-song-table[data-column-widths]) .song-grid");
    const narrow = css.indexOf("@container (max-width: 1080px)");
    expect(narrow).toBeGreaterThan(resized);
    expect(css.slice(narrow, narrow + 150)).toContain(".song-grid { --sc-album: 0px; }");
    expect(css.slice(narrow, narrow + 150)).toContain(".song-col--album { display: none !important; }");
    expect(css).not.toContain("--sc-w-title");
    expect(css).toContain("--sc-title: minmax(9rem, 2fr);");
    expect(css).toContain("--sc-title: minmax(min(9rem, max(0px, calc(100% - var(--sc-num) - var(--sc-cover) - var(--sc-end) - var(--sc-min-rest, 0px)))), 1fr);");
    expect(css).toContain("--sc-album: minmax(48px, var(--sc-w-album, 7.75rem));");
    expect(css).toContain("--sc-bpm: minmax(40px, var(--sc-w-bpm, 4.75rem));");
    expect(css).toContain('.song-column-resize[data-resize-side="left"] { left: -4px; right: auto; }');
    expect(css).toContain("width: 8px;"); expect(css).toContain("width: 2px;");
    expect(css).toContain("transition: opacity var(--dur-fast) var(--ease);");
    expect(css).toContain("transition-delay: 300ms;");
    expect(css).toContain(".song-column-resize::after { transition: none; }");
  });
});
