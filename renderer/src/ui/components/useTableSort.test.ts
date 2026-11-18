import { describe, expect, it } from "vitest";
import { sortTracks } from "./useTableSort";

describe("Key column sorting", () => {
  const codes = ["1A", "1B", "2A", "2B", "3A", "3B", "10A", "10B", "12A", "12B"];
  const tracks = ["12B", "3A", "2B", "10A", "1B", "12A", "2A", "3B", "1A", "10B"].map(key => ({ key }));
  const missing = [{ key: null }, { key: "" }, { analysis: { camelot: "1A" } }, { key: "invalid" }];

  it.each(["asc", "desc"])("orders by Camelot number then letter (%s), keeping missing values last", dir => {
    const input = [...missing, ...tracks];
    expect(sortTracks(input, "key", dir)).toEqual([...(dir === "asc" ? codes : [...codes].reverse()).map(key => ({ key })), ...missing]);
    expect(input).toEqual([...missing, ...tracks]);
  });

  it("sorts the resolved correction ahead of its stale analysis and accepts note names", () => {
    const corrected = { key: "2A", keySource: "fixed", analysis: { camelot: "12B" } };
    const named = { key: "B♭ minor" };
    expect(sortTracks([{ key: "10A" }, named, corrected, { key: "3B" }], "key", "asc")).toEqual([corrected, named, { key: "3B" }, { key: "10A" }]);
  });
});
