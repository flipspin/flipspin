import { describe, expect, it } from "vitest";
import { statusLifetime } from "./useStatusAutoClear";

describe("statusLifetime", () => {
  it("keeps nothing up when there is no message", () => {
    expect(statusLifetime(null)).toBeNull();
    expect(statusLifetime({ message: "" })).toBeNull();
  });

  it("leaves the «buscando» progress notice until it is replaced", () => {
    expect(statusLifetime({ message: "Buscando canciones nuevas...", type: "info" })).toBeNull();
  });

  it("gives errors and download notices 4 s, the rest 2 s", () => {
    expect(statusLifetime({ message: "Falló", type: "error" })).toBe(4000);
    expect(statusLifetime({ message: "Descargando 3 canciones nuevas...", type: "success" })).toBe(4000);
    expect(statusLifetime({ message: "Playlist actualizada", type: "success" })).toBe(2000);
  });
});
