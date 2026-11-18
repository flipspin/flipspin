import { afterEach, expect, it } from "vitest";
import { readMotion } from "./vizMotion";

afterEach(() => localStorage.clear());

it("starts the fullscreen view without auto motion, even where the old key stored it on", () => {
  localStorage.setItem("krobi.vizMotion", "1");
  expect(readMotion()).toBe(false);
});

it("keeps auto motion on only after the person turns it on", () => {
  localStorage.setItem("krobi.vizAutoMotion", "1");
  expect(readMotion()).toBe(true);
  localStorage.setItem("krobi.vizAutoMotion", "0");
  expect(readMotion()).toBe(false);
});
