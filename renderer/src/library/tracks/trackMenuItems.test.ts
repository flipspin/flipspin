import { describe, expect, it, vi } from "vitest";
import { trackFileItems } from "./trackMenuItems";
import { songMenuItems } from "./songMenuItems";

describe("trackFileItems", () => {
  it("is plugins · Editar etiquetas · Abrir archivo — no second lyric row", () => {
    const onEditTags = vi.fn();
    const track = { path: "/m/A/1.mp3" };
    const items = trackFileItems({ track, count: 1, onEditTags });
    const labels = items.map((i) => ("label" in i ? i.label : i.type));
    expect(labels).not.toContain("Letra…");
    expect(labels.slice(-2)).toEqual(["Editar etiquetas", "Abrir archivo"]);
    const item = items.find((i) => "label" in i && i.label === "Editar etiquetas");
    if (item && "onClick" in item) item.onClick?.();
    expect(onEditTags).toHaveBeenCalledWith(track);
  });
});

describe("songMenuItems lyrics", () => {
  const base = { onPlay: vi.fn(), onPlayNext: vi.fn(), onQueue: vi.fn() };
  it("puts «Ver letra» first inside Lyrics for one song", () => {
    const onOpenLyrics = vi.fn();
    const items = songMenuItems({ ...base, lyricsSubmenu: [{ label: "Buscar en los catálogos", onClick: vi.fn() }], onOpenLyrics });
    const lyrics = items.find((i) => "label" in i && i.label === "Letras");
    const sub = lyrics && "submenu" in lyrics ? lyrics.submenu ?? [] : [];
    expect(sub.map((i) => ("label" in i ? i.label : i.type))).toEqual(["Ver letra", "separator", "Buscar en los catálogos"]);
    const open = sub[0];
    if ("onClick" in open) open.onClick?.();
    expect(onOpenLyrics).toHaveBeenCalled();
    expect(items.filter((i) => "label" in i && /Letra/.test(i.label)).length).toBe(1);
  });
  it("keeps the plain submenu for several songs", () => {
    const items = songMenuItems({ ...base, lyricsSubmenu: [{ label: "Buscar en los catálogos", onClick: vi.fn() }] });
    const lyrics = items.find((i) => "label" in i && i.label === "Letras");
    expect(lyrics && "submenu" in lyrics ? lyrics.submenu?.length : 0).toBe(1);
  });
});
