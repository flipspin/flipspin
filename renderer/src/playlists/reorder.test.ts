import { describe, expect, it, vi } from "vitest";
import { canEditPlaylist, canMove, moveBlock, moveBottom, moveDown, moveTop, moveUp, reorderDisabledReason } from "./reorder";
import { reorderMenu } from "./reorderMenu";
import { songMenuItems } from "../library/tracks/songMenuItems";
const order = "abcdef".split("").map(path => ({ path }));
const paths = (songs: typeof order) => songs.map(song => song.path).join("");

describe("playlist block moves", () => {
  it("keeps the original internal order, including a scattered selection", () => {
    expect(paths(moveBlock(order, [order[3], order[1]], 3))).toBe("acebdf");
    expect(paths(order)).toBe("abcdef");
  });
  it("uses indexes after lifting and clamps both edges", () => {
    expect(paths(moveBlock(order, order.slice(1, 3), -10))).toBe("bcadef");
    expect(paths(moveBlock(order, order.slice(1, 3), 99))).toBe("adefbc");
    expect(paths(moveUp(order, order.slice(2, 4)))).toBe("acdbef");
    expect(paths(moveDown(order, order.slice(2, 4)))).toBe("abecdf");
  });
  it("returns the same array for every no-op and disables the edges", () => {
    expect(moveBlock(order, order.slice(1, 3), 1)).toBe(order);
    expect(moveBlock(order, [], 0)).toBe(order);
    expect(moveBlock(order, [{ path: "missing" }], 0)).toBe(order);
    expect(moveTop(order, order.slice(0, 2))).toBe(order);
    expect(moveUp(order, order.slice(0, 2))).toBe(order);
    expect(moveBottom(order, order.slice(-2))).toBe(order);
    expect(moveDown(order, order.slice(-2))).toBe(order);
    expect(moveBlock(order, order, 1)).toBe(order);
    for (const move of ["top", "up", "down", "bottom"] as const) expect(canMove(order, order, move)).toBe(false);
  });
});

describe("playlist edit and reorder rules", () => {
  it("shares server ownership rules for removal and reordering", () => {
    expect(canEditPlaylist("u1", { status: "ready", me: { id: "u1", role: "member" } })).toBe(true);
    expect(canEditPlaylist("u2", { status: "ready", me: { id: "u1", role: "member" } })).toBe(false);
    expect(canEditPlaylist(null, { status: "ready", me: { id: "u1", role: "member" } })).toBe(false);
    expect(canEditPlaylist("u2", { status: "ready", me: { id: "u1", isOwner: true } })).toBe(true);
    expect(canEditPlaylist(null, { status: "legacy" })).toBe(true);
    expect(canEditPlaylist(null, { status: "loading" })).toBe(false);
    expect(canEditPlaylist(null, { status: "unauthorized" })).toBe(false);
  });
  it("hides moves for permission, any column sort, or an active search", () => {
    expect(reorderDisabledReason(true, null, "")).toBe(null);
    expect(reorderDisabledReason(false, null, "")).toBe("permission");
    expect(reorderDisabledReason(true, "title", "")).toBe("sort");
    expect(reorderDisabledReason(true, null, "a")).toBe("search");
    expect(reorderMenu(order, [order[2]], false, vi.fn())).toEqual([]);
  });
  it("builds all four menu actions directly after adding to another playlist", () => {
    const onMove = vi.fn();
    const extra = reorderMenu(order, order.slice(0, 2), true, onMove);
    const items = songMenuItems({ onPlay: vi.fn(), onPlayNext: vi.fn(), onQueue: vi.fn(), playlistSubmenu: [], playlistLabel: "Añadir a otra playlist", afterPlaylist: extra, lyricsSubmenu: [] });
    expect(items.flatMap(item => "label" in item ? [item.label] : [])).toEqual(["Reproducir", "Reproducir a continuación", "Añadir a la cola", "Añadir a otra playlist", "Mover", "Letras"]);
    const menu = extra[0];
    if (!("submenu" in menu)) throw new Error("Missing submenu");
    const actions = menu.submenu!.filter(item => "label" in item);
    expect(actions.map(item => [item.label, item.disabled])).toEqual([["Al principio", true], ["Arriba", true], ["Abajo", false], ["Al final", false]]);
    actions[2].onClick!();
    expect(paths(onMove.mock.calls[0][0])).toBe("cabdef");
    expect(onMove.mock.calls[0][1]).toEqual(order.slice(0, 2));
    const bottom = reorderMenu(order, order.slice(-2), true, onMove)[0];
    if (!("submenu" in bottom)) throw new Error("Missing submenu");
    expect(bottom.submenu!.map(item => "disabled" in item && item.disabled)).toEqual([false, false, true, true]);
  });
});
