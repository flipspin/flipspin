import { describe, expect, it } from "vitest";
import { legacyErrorText } from "@lib/legacyErrorText";
import { ApiError } from "../../data/errors";

const base = { method: "GET", path: "/api/dashboard" };

describe("legacyErrorText", () => {
  it("shows the server's detail, then its message, then the status", () => {
    expect(legacyErrorText(new ApiError({ ...base, kind: "http", status: 409, body: { detail: "Proveedor apagado" }, message: "x" }))).toBe("Proveedor apagado");
    expect(legacyErrorText(new ApiError({ ...base, kind: "http", status: 500, body: { message: "boom" }, message: "x" }))).toBe("boom");
    expect(legacyErrorText(new ApiError({ ...base, kind: "http", status: 502, body: null, message: "x" }))).toBe("HTTP 502");
    expect(legacyErrorText(new ApiError({ ...base, kind: "http", status: 422, body: { detail: [{ msg: "bad" }] }, message: "x" }))).toBe('[{"msg":"bad"}]');
  });

  it("shows the network failure underneath, not the diagnostic message", () => {
    const error = new ApiError({ ...base, kind: "network", message: "GET /api/dashboard failed", cause: new TypeError("Failed to fetch") });
    expect(legacyErrorText(error)).toBe("Failed to fetch");
  });

  it("passes plain errors and values through", () => {
    expect(legacyErrorText(new Error("plain"))).toBe("plain");
    expect(legacyErrorText("text")).toBe("text");
    expect(legacyErrorText(undefined)).toBe("");
  });
});
