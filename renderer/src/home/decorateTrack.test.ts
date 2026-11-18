import { describe, expect, it } from "vitest";
import { decorate } from "./decorateTrack";
import { playHistoryKey } from "@lib/playHistory";

describe("decorate", () => {
  it("carries an album stub, never the album's tracks", () => {
    const album = { album: "Tête brûlée", path: "/m/Tete_brulee", artist: "X", tracks: [{ path: "/m/Tete_brulee/01.mp3" }] };
    const out = decorate({ path: "/m/Tete_brulee/01.mp3", title: "Uno" }, album);
    expect(out.album).not.toHaveProperty("tracks");
    expect(out.album).toMatchObject({ album: "Tête brûlée", artist: "X" });
    expect(out.url_path).toContain("/api/media/Tete_brulee/01.mp3");
  });
});

describe("playHistoryKey", () => {
  it("is keyed by the backend origin", () => {
    expect(playHistoryKey("http://192.168.1.20:8000/")).toBe("krobi.playHistory:http://192.168.1.20:8000");
    expect(playHistoryKey("http://localhost:8000")).not.toBe(playHistoryKey("http://192.168.1.20:8000"));
  });
});
