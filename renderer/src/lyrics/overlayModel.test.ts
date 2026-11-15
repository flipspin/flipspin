import i18n from '../i18n';
import { describe, expect, it, vi } from "vitest";

vi.mock("@lib/api", () => ({
  buildCoverImageUrl: (album: string) => `/cover/${album}`,
  parseTrackPath: (path: string) => ({ albumName: path.split("/").slice(-2, -1)[0] || null }),
}));

import {
  albumOf,
  bpmOf,
  coverOf,
  formatOffset,
  keyOf,
  offsetLines,
  parseOffsetDraft,
  round2,
  syncFootText,
} from "./overlayModel";
import type { TFunction } from "i18next";

const t = i18n.t as unknown as TFunction;

describe("overlayModel", () => {
  it("rounds to hundredths", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(-1.005)).toBe(-1);
  });

  it("formats the offset with a sign and a typographic minus", () => {
    expect(formatOffset(0.25)).toBe("+0.3 s");
    expect(formatOffset(-1)).toBe("−1.0 s");
    expect(formatOffset(0)).toBe("0.0 s");
  });

  it("parses a typed offset with a comma or a typographic minus", () => {
    expect(parseOffsetDraft("1,5")).toBe(1.5);
    expect(parseOffsetDraft("−0.333")).toBe(-0.33);
    expect(parseOffsetDraft("abc")).toBeNull();
  });

  it("applies the offset to timed lines only, never below zero", () => {
    const lines = [{ time: 1, text: "a" }, { time: null, text: "b" }, { time: 5, text: "c" }];
    expect(offsetLines(lines, 0)).toBe(lines);
    expect(offsetLines(lines, 2)).toEqual([{ time: 0, text: "a" }, { time: null, text: "b" }, { time: 3, text: "c" }]);
  });

  it("names every save state the popover reports, and nothing for idle", () => {
    expect(syncFootText("saving", t)).toBe("Guardando…");
    expect(syncFootText("error", t)).toBe("No se pudo guardar el desfase");
    expect(syncFootText("idle", t)).toBeNull();
  });

  it("reads the album, cover, tempo and key off the track's several shapes", () => {
    expect(albumOf({ album: { name: "N" } })).toBe("N");
    expect(albumOf({ album: { album: "A" } })).toBe("A");
    expect(albumOf({ album: "S" })).toBe("S");
    expect(albumOf(null)).toBe("");
    expect(coverOf({ album: { cover: "c.jpg" } })).toBe("c.jpg");
    expect(coverOf({ albumCover: "x.jpg" })).toBe("x.jpg");
    expect(coverOf({ path: "/m/Disco/a.mp3" })).toBe("/cover/Disco");
    expect(coverOf(null)).toBeNull();
    expect(bpmOf({ bpm: "120.6" })).toBe(121);
    expect(bpmOf({ bpm: 0 })).toBeNull();
    expect(bpmOf(null)).toBeNull();
    expect(keyOf({ key: "Am", analysis: { camelot: "8A" } })).toBe("8A");
    expect(keyOf({ key: "Am" })).toBe("Am");
  });
});
