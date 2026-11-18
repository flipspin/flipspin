import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RowScroller } from "./CoverRow";

describe("RowScroller", () => {
  it("keeps an empty shelf at a card's height with an invisible, unreachable card", () => {
    const { container } = render(<RowScroller empty="Nothing played yet." />);
    expect(screen.getByText("Nothing played yet.")).toBeTruthy();
    const ghost = container.querySelector(".cover-card");
    expect(ghost).not.toBeNull();
    const holder = ghost!.parentElement!;
    expect(holder.getAttribute("aria-hidden")).toBe("true");
    expect(holder.hasAttribute("inert")).toBe(true);
    expect(holder.className).toContain("invisible");
    expect(ghost!.getAttribute("style")).toContain("width: 140px");
    // The ghost adds no readable text, so the empty line is all a reader hears.
    expect(container.textContent).toBe("Nothing played yet.");
  });
});
