import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CollapsibleSearch from "./CollapsibleSearch";
import { focusSearch, focusSearchWhenReady } from "../../library/tracks/searchShortcut";
import css from "./CollapsibleSearch.css?raw";
import motionCss from "../tokens/app.css?raw";

function Search({ variant = "bare" }: { variant?: "bare" | "boxed" }) {
  const [value, setValue] = useState("");
  return <><CollapsibleSearch value={value} onChange={setValue} label="Buscar en la playlist" variant={variant} /><button>Otra cosa</button></>;
}

describe("collapsible search", () => {
  it("focuses before opening, accepts immediate typing, clears then closes on Escape", () => {
    const { container } = render(<Search />);
    const trigger = screen.getByRole("button", { name: "Buscar en la playlist" });
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    expect(input.tabIndex).toBe(-1);
    expect(trigger.getAttribute("aria-controls")).toBe(input.id);
    act(() => { expect(focusSearch()).toBe(true); });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(input.value).toBe("abc");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector("[data-open]")).toBeNull();
    expect(input.isConnected).toBe(true);
  });
  it("keeps an active query on blur; closes empty blur without taking focus back", () => {
    render(<Search />);
    const trigger = screen.getByRole("button", { name: "Buscar en la playlist" });
    const input = screen.getByRole("searchbox");
    const other = screen.getByText("Otra cosa");
    fireEvent.click(trigger);
    fireEvent.change(input, { target: { value: "x" } });
    act(() => other.focus());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "" } });
    act(() => other.focus());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(other);
  });
  it("clears and closes with × and reverses an interrupted opening", () => {
    render(<Search variant="boxed" />);
    const trigger = screen.getByRole("button", { name: "Buscar en la playlist" });
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.click(trigger);
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(trigger);
    fireEvent.change(input, { target: { value: "x" } });
    const clear = screen.getByRole("button", { name: "Cerrar búsqueda" });
    expect(fireEvent.mouseDown(clear)).toBe(false);
    expect(document.activeElement).toBe(input);
    fireEvent.click(clear);
    expect(input.value).toBe("");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
  it("opens a held shortcut request on mount and keeps motion on one width wrapper", () => {
    focusSearchWhenReady();
    render(<Search />);
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    expect(screen.getByRole("button", { name: "Buscar en la playlist" }).getAttribute("aria-expanded")).toBe("true");
    expect(css).toContain("inline-size var(--dur) var(--ease-out)");
    expect(css).toContain("inline-size var(--dur-fast) var(--ease)");
    expect(css).toContain("calc(var(--dur) - var(--dur-fast))");
    expect(motionCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(motionCss).toContain("--dur-fast: 0ms; --dur: 0ms;");
    expect(css).not.toMatch(/display:\s*none|visibility:\s*hidden|will-change|scaleX/);
  });
});
