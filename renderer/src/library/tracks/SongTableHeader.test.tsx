import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SongTableHeader from "./SongTableHeader";
import css from "../../styles/retro-song-table.css?raw";

describe("song table header", () => {
  it("marks only the active sort; idle arrows appear on hover or keyboard focus", () => {
    const { container } = render(<SongTableHeader sortField="artist" sortDir="desc" onSort={vi.fn()} />);
    expect(container.querySelectorAll("[data-sorted]")).toHaveLength(1);
    expect(container.querySelector("[data-sorted]")?.textContent).toBe("Artista");
    expect(container.querySelector("[data-sorted] .lucide-chevron-down")).toBeTruthy();
    expect(css).toContain(".song-sort-arrow { opacity: 0; }");
    expect(css).toContain('[data-sort-header]:is(:hover, :focus-visible, [data-sorted]) .song-sort-arrow { opacity: 1; }');
  });
  it("opens today's column picker on header right-click", () => {
    const { container } = render(<SongTableHeader sortField={null} sortDir="asc" onSort={vi.fn()} />);
    fireEvent.contextMenu(container.querySelector(".retro-song-table__header")!);
    expect(screen.getByRole("dialog", { name: "Columnas de la tabla" })).toBeTruthy();
    expect(screen.getByText("Siempre visible")).toBeTruthy();
  });
  it("scopes Geist to text cells and Geist Mono to numeric cells, retaining fallbacks", () => {
    expect(css).toMatch(/\.retro-song-table__row :is\(\.song-col--title, \.song-col--artist, \.song-col--album\) \{ font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;/);
    expect(css).toMatch(/\.retro-song-table__row :is\(\.song-row__num, \.song-col--bpm, \.song-col--date, \.song-col--duration\) \{ font-family: "Geist Mono", ui-monospace/);
  });
});
