import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageTransition } from "./pageTransition";

type Fake = (cb: () => void) => { finished: Promise<void> };
const setStart = (fn: Fake) => Object.defineProperty(document, "startViewTransition", { value: fn, configurable: true });

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).startViewTransition;
  delete document.documentElement.dataset.pageTransition;
});

describe("pageTransition", () => {
  it("names the page surface only while a transition runs", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let during: string | undefined;
    setStart((cb) => {
      during = document.documentElement.dataset.pageTransition;
      cb();
      return { finished };
    });
    const update = vi.fn();
    pageTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(during).toBe("");
    finish();
    await finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.pageTransition).toBeUndefined();
  });

  it("runs the update directly where the API is missing", () => {
    const update = vi.fn();
    pageTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.pageTransition).toBeUndefined();
  });

  it("never gives <main> a permanent view-transition-name (it traps position:fixed overlays in WebKit)", () => {
    const css = readFileSync(join(__dirname, "..", "tokens", "app.css"), "utf8");
    const rules = css.match(/[^{}]*\{[^{}]*view-transition-name[^{}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).toMatch(/\[data-page-transition\]/);
  });
});
