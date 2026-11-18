import { describe, expect, it } from "vitest";

import { genreLabel } from "./genreLabel";

describe("genreLabel", () => {
  it("shows the Spanish tag as written in Spanish", () => {
    expect(genreLabel("Latino, Alternativo", "es")).toBe("Latino, Alternativo");
  });

  it("translates each genre, one name each, in English", () => {
    expect(genreLabel("Latino, Alternativo", "en")).toBe("Latin Music, Alternative");
    expect(genreLabel(["Música tradicional mexicana"], "en-GB")).toBe("Traditional Mexicano");
  });

  it("leaves a name it does not know as written", () => {
    expect(genreLabel("blues, blues rock", "en")).toBe("blues, blues rock");
  });

  it("is empty for no genre", () => {
    expect(genreLabel(null, "en")).toBe("");
    expect(genreLabel("", "es")).toBe("");
  });
});
