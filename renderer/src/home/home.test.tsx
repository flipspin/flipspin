import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const layout = vi.hoisted(() => ({ portrait: false }));
vi.mock("../shell/usePortrait", () => ({ usePortrait: () => layout.portrait }));
vi.mock("./RecentAlbums", () => ({ default: () => <div>Recent albums</div> }));
vi.mock("./PlaylistsPanel", () => ({ default: () => <div>Playlists</div> }));
vi.mock("./MostPlayedPanel", () => ({ default: () => <div>Most played</div> }));
vi.mock("./LibraryStats", () => ({ default: () => <div>Library stats</div> }));
vi.mock("./JobsPanel", () => ({ default: () => <div>Jobs panel</div> }));
import Home from "./home";
import css from "./home-rail.css?raw";
import storiesCss from "./library-stories.css?raw";
afterEach(() => vi.unstubAllGlobals());

it("ships a zero-width fold attribute around a fixed-width rail clip", () => {
  expect(css).toMatch(/\.home-rail\s*\{[^}]*--home-rail-width: 320px;[^}]*width: var\(--home-rail-width\)/);
  expect(css).toMatch(/\.home-rail\[data-folded\]\s*\{\s*width: 0;/);
  expect(css).toMatch(/\.home-rail__clip\s*\{\s*width: 320px;/);
});

it("starts directly with listening content in the left scroll column and clips the Home-only rail", () => {
  layout.portrait = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const view = render(<Home />);
  expect(screen.queryByRole("heading", { name: "Inicio" })).toBeNull();
  expect(view.container.querySelector(".home-heading__sentinel")).toBeNull();
  expect(view.container.querySelector("main.home-main")?.firstElementChild).toHaveTextContent("Recent albums");
  expect(view.container.querySelector("aside.home-rail > .home-rail__clip")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  layout.portrait = true;
  view.rerender(<Home />);
  expect(screen.queryByRole("heading", { name: "Inicio" })).toBeNull();
  expect(view.container.querySelector(".home-rail")).toBeNull();
});

describe("Home", () => {
  it.each([false, true])("keeps music content, the jobs panel, and no active-downloads panel (portrait=%s)", (portrait) => {
    layout.portrait = portrait;
    render(<Home albums={[]} onOpenPlaylist={vi.fn()} />);
    expect(screen.getByText("Recent albums")).toBeInTheDocument();
    expect(screen.getByText("Library stats")).toBeInTheDocument();
    expect(screen.getByText("Jobs panel")).toBeInTheDocument();
    expect(screen.queryByText("Descargas activas")).toBeNull();
    expect(screen.queryByRole("button", { name: /Trabajos|Descargas/ })).toBeNull();
  });
});

it("keeps both Home column top edges on one shell offset", () => {
  for (const selector of ["home-main", "home-rail__clip"]) {
    const rule = css.match(new RegExp(`\\.${selector}\\s*\\{[^}]*\\}`))?.[0];
    expect(rule).toContain("padding: var(--shell-content-top)");
    expect(rule).not.toMatch(/padding[^;]*calc\(/);
  }
});

it("gives the floating library a square box and leaves Jobs the remaining rail height", () => {
  layout.portrait = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  render(<Home />);
  expect(screen.getByText("Library stats").parentElement).toHaveClass("home-library-square");
  expect(screen.getByText("Library stats").closest(".home-rail__clip")).toBeTruthy();
  expect(storiesCss).toMatch(/\.home-library-square\s*\{[^}]*width: 100%;[^}]*aspect-ratio: 1;[^}]*flex: none;/);
  expect(css).toMatch(/\.home-rail__jobs\s*\{[^}]*flex: 1;/);
});

it.each([false, true])("caps the compact square to Home's available height (portrait=%s)", (portrait) => {
  layout.portrait = portrait;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  render(<Home />);
  expect(screen.getByText("Library stats").parentElement).toHaveClass("home-library-square");
  expect(screen.getByText("Library stats").closest(".home-compact")).toBeTruthy();
  expect(storiesCss).toMatch(/\.home-compact\s*\{[^}]*container: home \/ size;/);
  expect(storiesCss).toMatch(/\.home-compact \.home-library-square\s*\{[^}]*max-width: 100cqh;/);
  expect(storiesCss).not.toMatch(/height: 640px/);
});
