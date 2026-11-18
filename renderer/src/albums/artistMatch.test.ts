import { describe, expect, it } from "vitest";

import { artistKey, primaryArtist, tagNames } from "./artistMatch";

describe("artistMatch", () => {
  it("links the primary artist, without the «feat.» tail", () => {
    expect(primaryArtist("Daft Punk feat. Pharrell Williams")).toBe("Daft Punk");
    expect(primaryArtist("Bad Bunny (feat. Drake)")).toBe("Bad Bunny");
    expect(primaryArtist("Simon & Garfunkel")).toBe("Simon & Garfunkel");
  });

  it("finds a featured artist and each name of a shared tag", () => {
    expect(tagNames("Daft Punk feat. Pharrell Williams", artistKey("Pharrell Williams"))).toBe(true);
    expect(tagNames("Rosalía & J Balvin", artistKey("Rosalia"))).toBe(true);
    expect(tagNames("Bad Bunny, Jhay Cortez", artistKey("bad bunny"))).toBe(true);
  });

  it("keeps an act whose name has an «&» whole", () => {
    expect(tagNames("Simon & Garfunkel", artistKey("Simon & Garfunkel"))).toBe(true);
  });

  it("does not match a name that is only inside another word", () => {
    expect(tagNames("Coldplay", artistKey("Cold"))).toBe(false);
    expect(tagNames("", artistKey("x"))).toBe(false);
  });
});
