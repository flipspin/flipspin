import { describe, expect, it } from "vitest";
import contract from "../../../contracts/playlist-page.json";
import { playlistFacts } from "./playlistFacts";

describe("playlistFacts (contracts/playlist-page.json)", () => {
  for (const c of contract.facts) {
    it(c.case, () => {
      expect(playlistFacts({ songs: c.canciones, seconds: c.segundos, downloaded: c.descargadas })).toBe(c.out);
    });
  }
});
