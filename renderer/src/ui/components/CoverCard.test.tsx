import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CoverCard from "./CoverCard";

function card(overrides: Partial<Parameters<typeof CoverCard>[0]> = {}) {
  const props = {
    cover: <span>art</span>,
    title: "Discovery",
    subtitle: "Daft Punk",
    onOpen: vi.fn(),
    openLabel: "Abrir Discovery",
    play: { onPlay: vi.fn(), onToggle: vi.fn() },
    onMenu: vi.fn(),
    ...overrides,
  };
  render(<CoverCard {...props} />);
  return props;
}

describe("CoverCard", () => {
  it("opens from the cover, plays from the disc, and the two never trigger each other", async () => {
    const user = userEvent.setup();
    const p = card();
    await user.click(screen.getByRole("button", { name: "Abrir Discovery" }));
    expect(p.onOpen).toHaveBeenCalledTimes(1);
    expect(p.play.onPlay).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reproducir Discovery" }));
    expect(p.play.onPlay).toHaveBeenCalledTimes(1);
    expect(p.onOpen).toHaveBeenCalledTimes(1);
  });

  it("never nests a button inside the open button", () => {
    card();
    const open = screen.getByRole("button", { name: "Abrir Discovery" });
    expect(open.querySelector("button")).toBeNull();
  });

  it("pauses and resumes the current item instead of restarting it", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const onToggle = vi.fn();
    const { rerender } = render(
      <CoverCard cover={null} title="Discovery" onOpen={() => {}} play={{ onPlay, onToggle, current: true, playing: true }} />,
    );
    const disc = screen.getByRole("button", { name: "Pausar Discovery" });
    expect(disc.getAttribute("aria-pressed")).toBe("true");
    expect(disc.querySelector(".krobi-disc--spinning")).not.toBeNull();
    await user.click(disc);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();

    rerender(<CoverCard cover={null} title="Discovery" onOpen={() => {}} play={{ onPlay, onToggle, current: true, playing: false }} />);
    const paused = screen.getByRole("button", { name: "Reanudar Discovery" });
    expect(paused.getAttribute("aria-pressed")).toBe("false");
    expect(paused.querySelector(".krobi-disc--spinning")).toBeNull();
  });

  it("opens the same menu from «⋯» and from a right-click", async () => {
    const user = userEvent.setup();
    const p = card();
    const more = screen.getByRole("button", { name: "Más opciones" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(more);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Abrir Discovery" }));
    expect(p.onMenu).toHaveBeenCalledTimes(2);
  });

  it("reaches every control from the keyboard, in reading order", async () => {
    const user = userEvent.setup();
    card();
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Abrir Discovery");
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Más opciones");
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Reproducir Discovery");
  });

  it("draws no disc for an item that cannot play", () => {
    card({ play: undefined });
    expect(screen.queryByRole("button", { name: /Reproducir/ })).toBeNull();
  });

  it("reveals its controls on keyboard focus and on touch, not only on hover", () => {
    const css = readFileSync(join(__dirname, "cover-card.css"), "utf8");
    expect(css).toMatch(/\.cover-card:is\(:hover, :focus-within, \[data-menu-open\]\) :is\(\.cover-card__more, \.cover-card__disc\)/);
    expect(css).toMatch(/@media \(hover: none\)/);
    expect(css).not.toMatch(/scale\(/);
  });
});
