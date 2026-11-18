/** The Ising lattice behind the sidebar screen (IsingScreen.tsx). */
export const ISING_COLS = 26;
export const ISING_ROWS = 12;
/** Where the starting pattern is drawn from before it is cooled to T 0. */
export const ISING_T = 2.6;

/**
 * Click cycles these; `attempts` is the share of the lattice tried per frame.
 * Idle is a real T = 0: only flips that lower the energy are taken, so the
 * domains smooth out and the lattice stops by itself (then the loop sleeps).
 */
export const STEPS = [
  { T: 0, attempts: 1 / 6 },
  { T: 2.27, attempts: 1 / 6 },
  { T: 3.0, attempts: 1 / 3 },
] as const;

/** "0", "2.27", "3.0": one decimal unless the second one matters. */
export function formatT(T: number): string {
  if (T === 0) return "0";
  return Math.round(T * 100) % 10 === 0 ? T.toFixed(1) : T.toFixed(2);
}

export type Lattice = { cols: number; rows: number; T: number; s: Int8Array };

export function makeLattice(cols: number, rows: number, T: number, random = Math.random): Lattice {
  const s = new Int8Array(cols * rows);
  for (let i = 0; i < s.length; i++) s[i] = random() < 0.5 ? 1 : -1;
  return { cols, rows, T, s };
}

/** `n` Metropolis attempts; flipped indices are added to `flipped` when given. */
export function metropolis(L: Lattice, n: number, flipped?: Set<number>, random = Math.random): void {
  const { cols, rows, T, s } = L;
  for (let k = 0; k < n; k++) {
    const i = (random() * cols * rows) | 0;
    const x = i % cols;
    const y = (i / cols) | 0;
    const nb =
      s[((y + rows - 1) % rows) * cols + x] +
      s[((y + 1) % rows) * cols + x] +
      s[y * cols + ((x + cols - 1) % cols)] +
      s[y * cols + ((x + 1) % cols)];
    const dE = 2 * s[i] * nb;
    // At T 0 only strictly downhill flips: zero-cost flips would keep a
    // settled lattice twitching forever.
    if (T <= 0 ? dE < 0 : dE <= 0 || random() < Math.exp(-dE / T)) {
      s[i] = -s[i] as 1 | -1;
      flipped?.add(i);
    }
  }
}


/** True when no spin can lower the energy by flipping: T 0 has nothing left to do. */
export function settled(L: Lattice): boolean {
  const { cols, rows, s } = L;
  for (let i = 0; i < s.length; i++) {
    const x = i % cols;
    const y = (i / cols) | 0;
    const nb =
      s[((y + rows - 1) % rows) * cols + x] +
      s[((y + 1) % rows) * cols + x] +
      s[y * cols + ((x + cols - 1) % cols)] +
      s[y * cols + ((x + 1) % cols)];
    if (s[i] * nb < 0) return false;
  }
  return true;
}

/** Run T 0 to the end (bounded), for a start that is already still. */
export function quench(L: Lattice, maxSweeps = 400): void {
  const T = L.T;
  L.T = 0;
  for (let k = 0; k < maxSweeps && !settled(L); k++) metropolis(L, L.cols * L.rows);
  L.T = T;
}
