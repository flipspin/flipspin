import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import IsingScreen from "./IsingScreen";
import { ISING_COLS, ISING_ROWS, ISING_T, STEPS, formatT, makeLattice, metropolis, quench, settled } from "./isingLattice";

describe("IsingScreen", () => {
  it("starts idle at T 0 and each click steps to the next temperature, then back", async () => {
    const user = userEvent.setup();
    render(<IsingScreen />);
    const screenButton = () => screen.getByRole("button", { name: /Ising a T/ });
    expect(screen.getByText("T 0")).toBeTruthy();
    expect(screenButton().getAttribute("aria-label")).toBe("Ising a T 0");
    expect(screenButton().getAttribute("title")).toBe("Cambiar temperatura del Ising");
    await user.click(screenButton());
    expect(screen.getByText("T 2.27")).toBeTruthy();
    expect(screenButton().getAttribute("aria-label")).toBe("Ising a T 2.27");
    await user.click(screenButton());
    expect(screen.getByText("T 3.0")).toBeTruthy();
    await user.click(screenButton());
    expect(screen.getByText("T 0")).toBeTruthy();
  });

  it("idles at a real T 0: the lattice settles and then nothing can flip", () => {
    expect(STEPS.map((s) => s.T)).toEqual([0, 2.27, 3.0]);
    const L = makeLattice(ISING_COLS, ISING_ROWS, ISING_T);
    metropolis(L, L.cols * L.rows * 40);
    L.T = 0;
    quench(L);
    expect(settled(L)).toBe(true);
    const flipped = new Set<number>();
    metropolis(L, 5000, flipped);
    expect(flipped.size).toBe(0);
    expect(formatT(0)).toBe("0");
    expect(formatT(2.6)).toBe("2.6");
    expect(formatT(2.27)).toBe("2.27");
    expect(formatT(3)).toBe("3.0");
  });

  it("reports exactly the spins that flipped, so only those are redrawn", () => {
    const L = makeLattice(ISING_COLS, ISING_ROWS, ISING_T);
    const before = Int8Array.from(L.s);
    const flipped = new Set<number>();
    metropolis(L, 200, flipped);
    for (let i = 0; i < L.s.length; i++) {
      const changed = L.s[i] !== before[i];
      // A spin flipped twice is back where it was and still reported: harmless.
      if (changed) expect(flipped.has(i)).toBe(true);
    }
    expect(flipped.size).toBeGreaterThan(0);
  });

  it("folds to its header with the bare icon and remembers it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<IsingScreen />);
    await user.click(screen.getByRole("button", { name: "Ocultar el Ising" }));
    expect(screen.queryByRole("button", { name: /Ising a T/ })).toBeNull();
    unmount();
    render(<IsingScreen />);
    expect(screen.getByRole("button", { name: "Mostrar el Ising" })).toHaveAttribute("aria-expanded", "false");
    localStorage.removeItem("krobi.isingCollapsed");
  });
});
